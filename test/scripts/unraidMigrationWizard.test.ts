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
    FAKE_PI_TYPE: "volume",
    FAKE_PI_SOURCE: "pi-volume",
    FAKE_APP_UID: String(process.getuid?.() || 1000),
    FAKE_APP_GID: String(process.getgid?.() || 1000),
  };
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("Unraid migration wizard", () => {
  it.each(["volume", "bind"])("creates the exact three files from a %s Pi mount", async (mountType) => {
    const piSource = mountType === "bind" ? path.join(tempDir, "pi-source") : "pi-volume";
    if (mountType === "bind") await fs.mkdir(piSource);

    const result = await runWizard({
      ...baseEnvironment,
      FAKE_PI_TYPE: mountType,
      FAKE_PI_SOURCE: piSource,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Migration export ready");
    const [exportDir] = (await fs.readdir(exportParent)).map((entry) => path.join(exportParent, entry));
    expect(await fs.readdir(exportDir)).toEqual(["SHA256SUMS", "aibot.dump", "pi-home.tgz"]);
    expect((await fs.readFile(path.join(exportDir, "SHA256SUMS"), "utf8"))).toContain("aibot.dump");

    const log = await fs.readFile(dockerLog, "utf8");
    expect(log).not.toMatch(/(?:^|\s)(?:stop|start|restart|rm)(?:\s|$)/u);
    expect(log).not.toContain("telegram-secret-token");
    expect(log).not.toContain("postgresql://aibot:database-secret");
    expect(log).not.toContain("bot-data");
    expect(log).toContain(`source=${piSource},target=/source,readonly`);
  });

  it("prompts for missing secrets without printing or passing them to Docker", async () => {
    const dbUrl = "postgresql://aibot:hidden-db-secret@postgres/aibot";
    const token = "hidden-telegram-secret";
    const result = await runWizard(
      { ...baseEnvironment, FAKE_DOCKER_SCENARIO: "missing-secrets" },
      `${baseInput(false)}${dbUrl}\n${token}\n\n`,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(dbUrl);
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(dbUrl);
    expect(await fs.readFile(dockerLog, "utf8")).not.toContain(token);
    expect(await fs.readdir(path.join(tempDir, "tmp"))).toEqual([]);
  });

  it.each([
    ["running-bot", "still running"],
    ["stopped-postgres", "PostgreSQL container is not running"],
    ["unhealthy-postgres", "health status"],
    ["no-network", "do not share a Docker network"],
    ["missing-pi", "exact /app/data/pi mount"],
    ["sqlite", "PostgreSQL connection validation failed"],
    ["postgres-18", "newer than the pinned version 17"],
    ["stale-marker", "already verified target"],
  ])("refuses unsafe source state: %s", async (scenario, message) => {
    const result = await runWizard({ ...baseEnvironment, FAKE_DOCKER_SCENARIO: scenario });

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(message);
    expect(await fs.readdir(exportParent)).toEqual([]);
  });

  it("rejects an output folder inside a bind-mounted Pi source", async () => {
    const result = await runWizard({
      ...baseEnvironment,
      FAKE_PI_TYPE: "bind",
      FAKE_PI_SOURCE: exportParent,
    });

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("must not overlap the source Pi mount");
    expect(await fs.readdir(exportParent)).toEqual([]);
  });

  it.each(["pg-restore-failure", "archive-failure", "checksum-failure"])(
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
  return `\n${exportParent}\n1\n1\n1\n${includeFinalPause ? "\n" : ""}`;
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
    "    printf '%s\\n' old-bot old-postgres",
    "    exit 0",
    "    ;;",
    "  inspect)",
    "    format=${2:-}",
    "    container=${3:-}",
    "    case \"$format\" in",
    "      *'.Config.Env'*)",
    "        if [[ \"$container\" == old-bot ]]; then",
    "          if [[ \"$FAKE_DOCKER_SCENARIO\" != missing-secrets ]]; then",
    "            printf '%s\\n' 'DB_URL=postgresql://aibot:database-secret@postgres/aibot' 'BOT_TOKEN=telegram-secret-token'",
    "          fi",
    "          printf '%s\\n' \"APP_UID=$FAKE_APP_UID\" \"APP_GID=$FAKE_APP_GID\" 'E2B_DEPLOYMENT_ID=source-e2b' 'BROWSER_USE_DEPLOYMENT_ID=source-browser'",
    "        fi",
    "        ;;",
    "      *'printf \"%s|%s|%s\"'*)",
    "        if [[ \"$FAKE_PI_TYPE\" == volume ]]; then printf 'volume|%s|/var/lib/docker/volumes/%s/_data' \"$FAKE_PI_SOURCE\" \"$FAKE_PI_SOURCE\"; else printf 'bind||%s' \"$FAKE_PI_SOURCE\"; fi",
    "        ;;",
    "      *'eq .Destination'*)",
    "        if [[ \"$container\" == old-bot && \"$FAKE_DOCKER_SCENARIO\" != missing-pi ]]; then printf yes; fi",
    "        ;;",
    "      '{{.Config.Image}}')",
    "        [[ \"$container\" == old-postgres ]] && printf 'postgres:17' || printf 'ai-tg-bot:old'",
    "        ;;",
    "      *'{{.Name}}'*)",
    "        if [[ \"$container\" == old-postgres ]]; then printf '/old-postgres | postgres:17 | running'; else printf '/old-bot | ai-tg-bot:old | exited'; fi",
    "        ;;",
    "      '{{.State.Running}}')",
    "        if [[ \"$container\" == old-postgres ]]; then [[ \"$FAKE_DOCKER_SCENARIO\" == stopped-postgres ]] && printf false || printf true; elif [[ \"$FAKE_DOCKER_SCENARIO\" == running-bot ]]; then printf true; else printf false; fi",
    "        ;;",
    "      *'.State.Health'*)",
    "        [[ \"$FAKE_DOCKER_SCENARIO\" == unhealthy-postgres ]] && printf unhealthy || printf healthy",
    "        ;;",
    "      *'NetworkSettings.Networks'*)",
    "        if [[ \"$FAKE_DOCKER_SCENARIO\" == no-network && \"$container\" == old-postgres ]]; then printf 'other-network\\n'; else printf 'database-network\\n'; fi",
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
    "        psql|pg_dump|pg_restore|tar) tool=$argument ;;",
    "      esac",
    "    done",
    "    if [[ \"$joined\" == *'upgrade-export-connection.js'* ]]; then",
    "      if [[ \"$FAKE_DOCKER_SCENARIO\" == sqlite ]]; then printf 'PostgreSQL connection validation failed\\n' >&2; exit 1; fi",
    "      exit 0",
    "    fi",
    "    if [[ \"$joined\" == *'test ! -e /source/upgrade-baseline.json.verified'* && \"$FAKE_DOCKER_SCENARIO\" == stale-marker ]]; then exit 1; fi",
    "    if [[ \"$tool\" == psql ]]; then",
    "      [[ \"$FAKE_DOCKER_SCENARIO\" == postgres-18 ]] && printf '180000\\n' || printf '170010\\n'",
    "      exit 0",
    "    fi",
    "    if [[ \"$tool\" == pg_dump ]]; then printf 'dump\\n' > \"$backup/.aibot.dump.partial\"; exit 0; fi",
    "    if [[ \"$tool\" == pg_restore ]]; then [[ \"$FAKE_DOCKER_SCENARIO\" != pg-restore-failure ]]; exit; fi",
    "    if [[ \"$tool\" == tar ]]; then printf 'archive\\n' > \"$backup/.pi-home.tgz.partial\"; exit 0; fi",
    "    if [[ \"$joined\" == *'archive=/backup/.pi-home.tgz.partial'* && \"$FAKE_DOCKER_SCENARIO\" == archive-failure ]]; then exit 1; fi",
    "    exit 0",
    "    ;;",
    "esac",
    "printf 'unsupported docker command: %s\\n' \"$command_name\" >&2",
    "exit 91",
    "",
  ].join("\n");
}
