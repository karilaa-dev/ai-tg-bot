import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const wizard = path.resolve("scripts/unraid-migration-wizard.sh");

let tempDir: string;
let binDir: string;
let exportParent: string;
let dockerLog: string;
let baseEnvironment: NodeJS.ProcessEnv;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-unraid-wizard-"));
  binDir = path.join(tempDir, "bin");
  exportParent = path.join(tempDir, "exports");
  dockerLog = path.join(tempDir, "docker.log");
  await fs.mkdir(binDir);
  await fs.mkdir(exportParent);
  await fs.mkdir(path.join(tempDir, "tmp"));
  await fs.writeFile(path.join(binDir, "docker"), fakeDockerScript(), { mode: 0o755 });
  await fs.writeFile(path.join(binDir, "sha256sum"), [
    "#!/usr/bin/env bash",
    "set -eu",
    "if [[ \"${FAKE_DOCKER_SCENARIO:-}\" == checksum-failure && \" $* \" == *' --check '* ]]; then exit 1; fi",
    "exec /usr/bin/sha256sum \"$@\"",
    "",
  ].join("\n"), { mode: 0o755 });
  baseEnvironment = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    TMPDIR: path.join(tempDir, "tmp"),
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_DOCKER_SCENARIO: "success",
    FAKE_APPDATA_TYPE: "volume",
    FAKE_APPDATA_SOURCE: "appdata-volume",
    FAKE_APP_UID: String(process.getuid?.() || 1000),
    FAKE_APP_GID: String(process.getgid?.() || 1000),
  };
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("Unraid migration wizard", () => {
  it.each(["volume", "bind"])("creates the exact two files from a %s appdata mount", async (mountType) => {
    const appdataSource = mountType === "bind" ? path.join(tempDir, "appdata-source") : "appdata-volume";
    if (mountType === "bind") await fs.mkdir(appdataSource);

    const result = await runWizard({
      ...baseEnvironment,
      FAKE_APPDATA_TYPE: mountType,
      FAKE_APPDATA_SOURCE: appdataSource,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Migration export ready");
    const [exportDir] = (await fs.readdir(exportParent)).map((entry) => path.join(exportParent, entry));
    expect(await fs.readdir(exportDir)).toEqual(["SHA256SUMS", "app-data.tgz"]);
    expect((await fs.readFile(path.join(exportDir, "SHA256SUMS"), "utf8"))).toContain("app-data.tgz");

    const log = await fs.readFile(dockerLog, "utf8");
    expect(log).not.toMatch(/(?:^|\s)(?:stop|start|restart|rm)(?:\s|$)/u);
    expect(log).not.toContain("telegram-secret-token");
    expect(log).not.toContain("/mnt/user/ai-bot,target=/source");
    expect(log).toContain(`source=${appdataSource},target=/source,readonly`);
  });

  it("prompts for missing secrets without printing or passing them to Docker", async () => {
    const token = "hidden-telegram-secret";
    const result = await runWizard(
      { ...baseEnvironment, FAKE_DOCKER_SCENARIO: "missing-secrets" },
      `${baseInput(false)}${token}\n\n`,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(token);
    expect(await fs.readFile(dockerLog, "utf8")).not.toContain(token);
    expect(await fs.readdir(path.join(tempDir, "tmp"))).toEqual([]);
  });

  it.each([
    ["running-bot", "still running"],
    ["missing-appdata", "expected /app/data appdata mount"],
    ["postgres", "must use SQLite"],
    ["prepare-failure", "Export stopped"],
  ])("refuses unsafe source state: %s", async (scenario, message) => {
    const result = await runWizard({ ...baseEnvironment, FAKE_DOCKER_SCENARIO: scenario });

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(message);
    expect(await fs.readdir(exportParent)).toEqual([]);
  });

  it("rejects an output folder inside a bind-mounted appdata source", async () => {
    const result = await runWizard({
      ...baseEnvironment,
      FAKE_APPDATA_TYPE: "bind",
      FAKE_APPDATA_SOURCE: exportParent,
    });

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("must not overlap the source appdata mount");
    expect(await fs.readdir(exportParent)).toEqual([]);
  });

  it.each(["sqlite-backup-failure", "audit-failure", "archive-failure", "verify-failure", "checksum-failure"])(
    "removes partial artifacts after %s",
    async (scenario) => {
      const result = await runWizard({ ...baseEnvironment, FAKE_DOCKER_SCENARIO: scenario });

      expect(result.code).not.toBe(0);
      expect(await fs.readdir(exportParent)).toEqual([]);
      const log = await fs.readFile(dockerLog, "utf8");
      expect(log).not.toMatch(/(?:^|\s)(?:stop|start|restart|rm)(?:\s|$)/u);
    },
  );
});

function baseInput(includeFinalPause = true): string {
  return `\n${exportParent}\n1\n${includeFinalPause ? "\n" : ""}`;
}

async function runWizard(
  environment: NodeJS.ProcessEnv,
  input = baseInput(),
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("bash", [wizard], { env: environment, cwd: path.resolve(".") });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function fakeDockerScript(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf '%s\\n' \"$*\" >> \"$FAKE_DOCKER_LOG\"",
    "command_name=${1:-}",
    "shift || true",
    "case \"$command_name\" in",
    "  info|build) exit 0 ;;",
    "  ps)",
    "    printf '%s\\n' old-bot",
    "    exit 0",
    "    ;;",
    "  inspect)",
    "    format=${2:-}",
    "    container=${3:-}",
    "    case \"$format\" in",
    "      *'.Config.Env'*)",
    "        if [[ \"$container\" == old-bot ]]; then",
    "          [[ \"$FAKE_DOCKER_SCENARIO\" == missing-secrets ]] || printf '%s\\n' 'BOT_TOKEN=telegram-secret-token'",
    "          if [[ \"$FAKE_DOCKER_SCENARIO\" == postgres ]]; then printf '%s\\n' 'DB_URL=postgresql://aibot:secret@postgres/aibot'; else printf '%s\\n' 'DB_URL=sqlite:/app/data/bot.db'; fi",
    "          printf '%s\\n' 'PI_CODING_AGENT_DIR=/app/data/pi' \"APP_UID=$FAKE_APP_UID\" \"APP_GID=$FAKE_APP_GID\" 'E2B_DEPLOYMENT_ID=source-e2b' 'BROWSER_USE_DEPLOYMENT_ID=source-browser'",
    "        fi",
    "        ;;",
    "      *'printf \"%s|%s|%s\"'*)",
    "        if [[ \"$format\" == *'/app/data/files'* ]]; then printf 'bind||/mnt/user/ai-bot'; elif [[ \"$FAKE_APPDATA_TYPE\" == volume ]]; then printf 'volume|%s|/var/lib/docker/volumes/%s/_data' \"$FAKE_APPDATA_SOURCE\" \"$FAKE_APPDATA_SOURCE\"; else printf 'bind||%s' \"$FAKE_APPDATA_SOURCE\"; fi",
    "        ;;",
    "      *'eq .Destination'*)",
    "        if [[ \"$container\" == old-bot && \"$FAKE_DOCKER_SCENARIO\" != missing-appdata ]]; then printf yes; fi",
    "        ;;",
    "      *'{{.Name}}'*)",
    "        printf '/old-bot | ai-tg-bot:old | exited'",
    "        ;;",
    "      '{{.State.Running}}')",
    "        [[ \"$FAKE_DOCKER_SCENARIO\" == running-bot ]] && printf true || printf false",
    "        ;;",
    "      *) printf 'unsupported inspect format: %s\\n' \"$format\" >&2; exit 90 ;;",
    "    esac",
    "    exit 0",
    "    ;;",
    "  run)",
    "    backup=''",
    "    tool=''",
    "    joined=\" $* \"",
    "    for argument in \"$@\"; do",
    "      case \"$argument\" in",
    "        type=bind,source=*,target=/backup*) backup=${argument#type=bind,source=}; backup=${backup%%,target=/backup*} ;;",
    "        tar) tool=$argument ;;",
    "      esac",
    "    done",
    "    if [[ \"$joined\" == *'mkdir -p /backup/app-data/pi'* ]]; then mkdir -p \"$backup/app-data/pi\"; exit 0; fi",
    "    if [[ \"$joined\" == *'upgrade-audit.js snapshot'* ]]; then [[ \"$FAKE_DOCKER_SCENARIO\" != audit-failure ]] || exit 1; printf '{}\\n' > \"$backup/.baseline.json\"; exit 0; fi",
    "    if [[ \"$joined\" == *'upgrade-export-sqlite.js'* ]]; then [[ \"$FAKE_DOCKER_SCENARIO\" != sqlite-backup-failure ]] || exit 1; printf 'sqlite-backup\\n' > \"$backup/app-data/bot.db\"; exit 0; fi",
    "    if [[ \"$joined\" == *'archive=/backup/.pi-copy.tgz'* && \"$FAKE_DOCKER_SCENARIO\" == archive-failure ]]; then exit 1; fi",
    "    if [[ \"$joined\" == *'/backup/.pi-copy.tgz'* && \"$tool\" == tar ]]; then printf 'pi-archive\\n' > \"$backup/.pi-copy.tgz\"; exit 0; fi",
    "    if [[ \"$joined\" == *'prepare-migration-data.js'* ]]; then [[ \"$FAKE_DOCKER_SCENARIO\" != prepare-failure ]]; exit; fi",
    "    if [[ \"$joined\" == *'upgrade-audit.js verify'* ]]; then [[ \"$FAKE_DOCKER_SCENARIO\" != verify-failure ]]; exit; fi",
    "    if [[ \"$joined\" == *'/backup/.app-data.tgz.partial'* && \"$tool\" == tar ]]; then printf 'app-data-archive\\n' > \"$backup/.app-data.tgz.partial\"; exit 0; fi",
    "    exit 0",
    "    ;;",
    "esac",
    "printf 'unsupported docker command: %s\\n' \"$command_name\" >&2",
    "exit 91",
    "",
  ].join("\n");
}
