import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { EMPTY_BYTES, InMemoryFs, getCommandNames, getJavaScriptCommandNames, getNetworkCommandNames, getPythonCommandNames } from "just-bash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { buildToolRegistry } from "../../src/ai/tools/index.js";
import { zipCommand } from "../../src/ai/tools/zipCommand.js";

type BashResultForTests = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  cwd: string;
  error?: string;
};

type BashToolForTests = {
  execute(input: unknown): Promise<BashResultForTests>;
};

type CommandCase = {
  script: string;
  stdin?: string;
  raw_script?: boolean;
  exitCode?: number | null;
  stdout?: string | RegExp;
  stderr?: string | RegExp;
};

const CORE_COMMAND_CASES = {
  echo: { script: "echo echo-ok", stdout: "echo-ok\n" },
  cat: { script: "printf 'cat-ok\\n' > cat.txt; cat cat.txt", stdout: "cat-ok\n" },
  printf: { script: "printf 'printf-ok\\n'", stdout: "printf-ok\n" },
  ls: { script: "mkdir -p lsdir; touch lsdir/listed; ls lsdir", stdout: /listed/ },
  mkdir: { script: "mkdir mkdir-ok; ls | grep mkdir-ok", stdout: /mkdir-ok/ },
  rmdir: {
    script: "mkdir rmdir-empty; rmdir rmdir-empty",
    exitCode: 1,
    stderr: /failed to remove|ERR_FS_EISDIR/,
  },
  touch: { script: "touch touched; ls touched", stdout: /touched/ },
  rm: { script: "touch rm-doomed; rm rm-doomed; ls rm-doomed || echo rm-ok", stdout: /rm-ok/ },
  cp: { script: "printf cp-ok > cp-a; cp cp-a cp-b; cat cp-b", stdout: "cp-ok" },
  mv: { script: "printf mv-ok > mv-a; mv mv-a mv-b; cat mv-b", stdout: "mv-ok" },
  ln: { script: "printf ln-ok > ln-a; ln ln-a ln-b; cat ln-b", stdout: "ln-ok" },
  chmod: { script: "touch chmod-file; chmod 600 chmod-file; stat -c '%a' chmod-file", stdout: /600\n$/ },
  pwd: { script: "pwd", stdout: "/\n" },
  readlink: {
    script: "readlink readlink-missing",
    exitCode: 1,
  },
  head: { script: "printf 'head-ok\\nnext\\n' > head-file; head -1 head-file", stdout: "head-ok\n" },
  tail: { script: "printf 'first\\ntail-ok\\n' > tail-file; tail -1 tail-file", stdout: "tail-ok\n" },
  wc: { script: "printf 'abcd' | wc -c", stdout: /4/ },
  stat: { script: "printf stat-ok > stat-file; stat stat-file", stdout: /File: stat-file/ },
  grep: { script: "printf 'miss\\ngrep-ok\\n' | grep grep-ok", stdout: "grep-ok\n" },
  fgrep: { script: "printf 'fgrep-ok[]\\n' | fgrep 'fgrep-ok[]'", stdout: "fgrep-ok[]\n" },
  egrep: { script: "printf 'egrep-42\\n' | egrep 'egrep-[0-9]+'", stdout: "egrep-42\n" },
  rg: { script: "printf 'rg-ok\\n' > rg-file; rg rg-ok rg-file", stdout: /rg-ok/ },
  sed: { script: "printf 'sed-no\\n' | sed 's/no/ok/'", stdout: "sed-ok\n" },
  awk: { script: "printf '20 22\\n' | awk '{print $1+$2}'", stdout: "42\n" },
  sort: { script: "printf 'z\\nsort-ok\\n' | sort | head -1", stdout: "sort-ok\n" },
  uniq: { script: "printf 'uniq-ok\\nuniq-ok\\n' | uniq", stdout: "uniq-ok\n" },
  comm: { script: "printf 'a\\ncomm-ok\\n' > comm-a; printf 'comm-ok\\nz\\n' > comm-b; comm -12 comm-a comm-b", stdout: "comm-ok\n" },
  cut: { script: "printf 'left:cut-ok\\n' | cut -d: -f2", stdout: "cut-ok\n" },
  paste: { script: "printf 'paste\\n' > paste-a; printf 'ok\\n' > paste-b; paste -d- paste-a paste-b", stdout: "paste-ok\n" },
  tr: { script: "printf tr-ok | tr a-z A-Z", stdout: "TR-OK" },
  rev: { script: "printf ko-ver | rev", stdout: "rev-ok" },
  nl: { script: "printf 'nl-ok\\n' | nl", stdout: /nl-ok/ },
  fold: { script: "printf foldok | fold -w4", stdout: "fold\nok" },
  expand: { script: "printf 'a\\tb\\n' | expand -t 4", stdout: "a   b\n" },
  unexpand: { script: "printf '    unexpand-ok\\n' | unexpand -t 4", stdout: "\tunexpand-ok\n" },
  strings: { script: "printf '\\0strings-ok\\0' > strings.bin; strings strings.bin", stdout: /strings-ok/ },
  split: { script: "printf 'split-a\\nsplit-b\\n' > split-file; split -l 1 split-file split-part; ls split-part*", stdout: /split-part/ },
  column: { script: "printf 'column ok\\nwide value\\n' | column -t", stdout: /column\s+ok/ },
  join: { script: "printf '1 join\\n' > join-a; printf '1 ok\\n' > join-b; join join-a join-b", stdout: "1 join ok\n" },
  tee: { script: "printf tee-ok | tee tee-file", stdout: "tee-ok" },
  find: { script: "mkdir -p find-dir; touch find-dir/find-ok; find find-dir -name find-ok", stdout: /find-dir\/find-ok/ },
  basename: { script: "basename /tmp/basename-ok.txt .txt", stdout: "basename-ok\n" },
  dirname: { script: "dirname /tmp/dirname-ok/file.txt", stdout: "/tmp/dirname-ok\n" },
  tree: { script: "mkdir -p tree-dir; touch tree-dir/tree-ok; tree tree-dir", stdout: /tree-ok/ },
  du: { script: "printf du-ok > du-file; du du-file", stdout: /du-file/ },
  env: { script: "env | grep '^TZ='", stdout: "TZ=UTC\n" },
  printenv: { script: "printenv TZ", stdout: "UTC\n" },
  alias: { script: "alias hi='echo alias-ok'; alias hi", stdout: /alias hi=/ },
  unalias: { script: "alias bye='echo nope'; unalias bye; alias bye || echo unalias-ok", stdout: /unalias-ok/ },
  history: { script: "echo history-before; history; echo history-ok", stdout: /history-ok/ },
  xargs: { script: "printf 'xargs-ok' | xargs echo", stdout: "xargs-ok\n" },
  true: { script: "true && echo true-ok", stdout: "true-ok\n" },
  false: { script: "false || echo false-ok", stdout: "false-ok\n" },
  clear: { script: "clear; echo clear-ok", stdout: /clear-ok/ },
  bash: { script: "bash -c 'echo bash-ok'", stdout: "bash-ok\n" },
  sh: { script: "sh -c 'echo sh-ok'", stdout: "sh-ok\n" },
  jq: { script: "printf '{\"jq\":42}' | jq -r '.jq'", stdout: "42\n" },
  base64: { script: "printf abc | base64", stdout: /YWJj/ },
  diff: { script: "printf same > diff-a; printf same > diff-b; diff diff-a diff-b; echo diff-ok", stdout: "diff-ok\n" },
  date: { script: "date -u +%Z", stdout: "UTC\n" },
  sleep: { script: "sleep 0; echo sleep-ok", stdout: "sleep-ok\n" },
  timeout: { script: "timeout 1 echo timeout-ok", stdout: "timeout-ok\n" },
  time: { script: "time echo time-ok", stdout: /time-ok/ },
  seq: { script: "seq 2 3", stdout: "2\n3\n" },
  expr: { script: "expr 40 + 2", stdout: "42\n" },
  md5sum: { script: "printf abc | md5sum", stdout: /^900150983cd24fb0d6963f7d28e17f72/ },
  sha1sum: { script: "printf abc | sha1sum", stdout: /^a9993e364706816aba3e25717850c26c9cd0d89d/ },
  sha256sum: { script: "printf abc | sha256sum", stdout: /^ba7816bf8f01cfea414140de5dae2223/ },
  file: { script: "printf file-ok > file-probe.txt; file file-probe.txt", stdout: /file-probe\.txt/ },
  "html-to-markdown": { script: "printf '<h1>Markdown OK</h1>' | html-to-markdown", stdout: /Markdown OK/ },
  help: { script: "help echo", stdout: /echo/ },
  which: { script: "mkdir -p /bin; touch /bin/which-ok; which which-ok", stdout: "/bin/which-ok\n" },
  tac: { script: "printf 'first\\ntac-ok\\n' | tac | head -1", stdout: "tac-ok\n" },
  hostname: { script: "hostname", stdout: /\S/ },
  whoami: { script: "whoami", stdout: /\S/ },
  od: { script: "printf A | od -An -t x1", stdout: /41/ },
  gzip: { script: "printf gzip-ok > gzip-file; gzip gzip-file; gunzip gzip-file.gz; cat gzip-file", stdout: "gzip-ok" },
  gunzip: { script: "printf gunzip-ok > gunzip-file; gzip gunzip-file; gunzip gunzip-file.gz; cat gunzip-file", stdout: "gunzip-ok" },
  zcat: { script: "printf zcat-ok > zcat-file; gzip -c zcat-file > zcat-file.gz; zcat zcat-file.gz", stdout: "zcat-ok" },
  tar: { script: "mkdir tar-dir; printf tar-ok > tar-dir/file; tar -cf archive.tar tar-dir; rm -r tar-dir; tar -xf archive.tar; cat tar-dir/file", stdout: "tar-ok" },
  yq: { script: "printf 'answer: 42\\n' > yq-file.yml; yq '.answer' yq-file.yml", stdout: "42\n" },
  xan: { script: "printf 'a,b\\n1,2\\n3,4\\n' > xan-file.csv; xan count xan-file.csv", stdout: "2\n" },
  sqlite3: { script: "sqlite3 :memory: 'select 40 + 2;'", stdout: "42\n" },
} satisfies Record<string, CommandCase>;

const JAVASCRIPT_COMMAND_CASES = {
  "js-exec": { script: "js-exec -c 'console.log(40 + 2)'", stdout: "42\n" },
  node: {
    script: "node --help",
    exitCode: 1,
    stderr: /this sandbox uses js-exec instead of node/,
  },
} satisfies Record<string, CommandCase>;

const PYTHON_COMMAND_CASES = {
  python3: { script: "python3 -c 'print(40 + 2)'", stdout: "42\n" },
  python: { script: "python -c 'print(20 + 22)'", stdout: "42\n" },
} satisfies Record<string, CommandCase>;

describe("just-bash coverage through the bot bash tool", () => {
  let db: AppDatabase;
  let repos: Repos;
  let tempDirs: string[] = [];

  beforeEach(async () => {
    const config = loadTestConfig();
    db = createDatabase(config, createLogger(config));
    await db.migrate();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    await db.destroy();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("covers every installed core just-bash command through the bot tool", async () => {
    expect(Object.keys(CORE_COMMAND_CASES).sort()).toEqual([...getCommandNames()].sort());
    const bash = await createBashTool({ timeoutMs: 30_000, maxOutputChars: 50_000 });

    for (const [name, testCase] of Object.entries(CORE_COMMAND_CASES) as Array<[string, CommandCase]>) {
      const result = await bash.execute({
        script: testCase.script,
        stdin: testCase.stdin,
        raw_script: testCase.raw_script,
      });
      assertBashCase(name, result, testCase);
    }
  }, 60_000);

  it("covers enabled JavaScript, Python, and public curl while blocking private network ranges", async () => {
    expect(Object.keys(JAVASCRIPT_COMMAND_CASES).sort()).toEqual([...getJavaScriptCommandNames()].sort());
    expect(Object.keys(PYTHON_COMMAND_CASES).sort()).toEqual([...getPythonCommandNames()].sort());
    expect(getNetworkCommandNames()).toEqual(["curl"]);
    const bash = await createBashTool({ timeoutMs: 30_000, maxOutputChars: 50_000 });

    for (const [name, testCase] of Object.entries({ ...JAVASCRIPT_COMMAND_CASES, ...PYTHON_COMMAND_CASES }) as Array<
      [string, CommandCase]
    >) {
      const result = await bash.execute({ script: testCase.script });
      assertBashCase(name, result, testCase);
    }

    let publicFetchCalls = 0;
    await withMockFetch(async (resource, init) => {
      publicFetchCalls += 1;
      expect(String(resource)).toBe("http://93.184.216.34/pi");
      expect(init?.method).toBe("GET");
      return new Response("curl-public-ok\n", { status: 200, headers: { "content-type": "text/plain" } });
    }, async () => {
      const result = await bash.execute({ script: "curl -s http://93.184.216.34/pi" });
      expect(result).toMatchObject({ exit_code: 0, timed_out: false });
      expect(result.stdout).toBe("curl-public-ok\n");
    });
    expect(publicFetchCalls).toBe(1);

    let privateFetchCalls = 0;
    await withMockFetch(async () => {
      privateFetchCalls += 1;
      throw new Error("private fetch should have been blocked before fetch");
    }, async () => {
      const result = await bash.execute({ script: "curl -s http://127.0.0.1/private" });
      expect(result).toMatchObject({ timed_out: false });
      expect(result.exit_code).not.toBe(0);
    });
    expect(privateFetchCalls).toBe(0);
  }, 60_000);

  it("creates a recursive ZIP archive with the bash zip command", async () => {
    const bash = await createBashTool({ timeoutMs: 30_000, maxOutputChars: 100_000 });
    const result = await bash.execute({
      script: [
        "mkdir -p bundle/nested bundle/empty",
        "printf root-file > bundle/root.txt",
        "printf nested-file > bundle/nested/item.txt",
        "zip -rq archive.zip bundle",
        "base64 archive.zip",
      ].join("; "),
    });

    expect(result).toMatchObject({ exit_code: 0, timed_out: false, stderr: "" });
    const archive = Buffer.from(result.stdout.replace(/\s/g, ""), "base64");
    const files = unzipSync(archive);
    expect(Object.keys(files).sort()).toEqual([
      "bundle/",
      "bundle/empty/",
      "bundle/nested/",
      "bundle/nested/item.txt",
      "bundle/root.txt",
    ]);
    expect(Buffer.from(files["bundle/root.txt"]!).toString()).toBe("root-file");
    expect(Buffer.from(files["bundle/nested/item.txt"]!).toString()).toBe("nested-file");
  }, 60_000);

  it("keeps recursive junk-path ZIP archives flat without directory collisions", async () => {
    const bash = await createBashTool({ timeoutMs: 30_000, maxOutputChars: 100_000 });
    const result = await bash.execute({
      script: [
        "mkdir -p left/shared right/shared",
        "printf left-file > left/shared/left.txt",
        "printf right-file > right/shared/right.txt",
        "zip -jrq flat.zip left right",
        "base64 flat.zip",
      ].join("; "),
    });

    expect(result).toMatchObject({ exit_code: 0, timed_out: false, stderr: "" });
    const archive = Buffer.from(result.stdout.replace(/\s/g, ""), "base64");
    const files = unzipSync(archive);
    expect(Object.keys(files).sort()).toEqual(["left.txt", "right.txt"]);
    expect(Buffer.from(files["left.txt"]!).toString()).toBe("left-file");
    expect(Buffer.from(files["right.txt"]!).toString()).toBe("right-file");
  }, 60_000);

  it("cancels asynchronous ZIP compression without writing a partial archive", async () => {
    const virtualFs = new InMemoryFs({ "/large.bin": new Uint8Array(1024 * 1024) });
    const controller = new AbortController();
    const resultPromise = zipCommand.execute(["archive.zip", "large.bin"], {
      fs: virtualFs,
      cwd: "/",
      env: new Map(),
      stdin: EMPTY_BYTES,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 0);

    await expect(resultPromise).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/abort/i) });
    await expect(virtualFs.exists("/archive.zip")).resolves.toBe(false);
  }, 60_000);

  it("covers shell features and tool input options used by agents", async () => {
    const bash = await createBashTool({ timeoutMs: 30_000, maxOutputChars: 50_000 });
    const argsResult = await bash.execute({ script: "printf '%s|%s\\n'", args: ["arg-one", "arg two"] });
    expect(argsResult).toMatchObject({ exit_code: 0, timed_out: false });
    expect(argsResult.stdout).toBe("arg-one|arg two\n");

    const prepared = await bash.execute({ script: "mkdir -p /project/data" });
    expect(prepared).toMatchObject({ exit_code: 0, timed_out: false });

    const result = await bash.execute({
      cwd: "/project",
      stdin: "stdin-ok\n",
      raw_script: true,
      script: [
        "cat > data/input.txt",
        "printf 'glob-a\\nglob-b\\n' > data/glob-a.txt",
        "printf 'glob-c\\n' > data/glob-b.txt",
        "cat data/input.txt",
        "echo \"$CUSTOM_UNSET\"${CUSTOM_UNSET:-default-ok}",
        "if grep -q stdin-ok data/input.txt; then echo if-ok; else echo if-bad; fi",
        "f() { local item=$1; echo function-$item; }",
        "f ok",
        "for item in one two; do echo for-$item; done",
        "while true; do echo while-ok; break; done",
        "until false; do echo until-ok; break; done",
        "echo command-sub-$(printf ok)",
        "cat <<EOF > data/here.txt",
        "  heredoc-ok",
        "EOF",
        "cat data/here.txt",
        "ln data/input.txt data/input-hard",
        "printf hard-; cat data/input-hard",
        "printf '%s\\n' data/glob-*.txt | sort",
      ].join("\n"),
    });

    expect(result).toMatchObject({ exit_code: 0, timed_out: false, cwd: "/project" });
    expect(result.stdout).toContain("stdin-ok\n");
    expect(result.stdout).toContain("default-ok\n");
    expect(result.stdout).toContain("if-ok\n");
    expect(result.stdout).toContain("function-ok\n");
    expect(result.stdout).toContain("for-one\nfor-two\n");
    expect(result.stdout).toContain("while-ok\nuntil-ok\n");
    expect(result.stdout).toContain("command-sub-ok\n");
    expect(result.stdout).toContain("  heredoc-ok\n");
    expect(result.stdout).toContain("hard-stdin-ok\n");
    expect(result.stdout).toContain("data/glob-a.txt\ndata/glob-b.txt\n");

    const whileTest = await bash.execute({ script: "i=0; while [ $i -lt 2 ]; do echo while-$i; i=$((i + 1)); done" });
    expect(whileTest.exit_code).toBe(1);
    expect(whileTest.stderr).toMatch(/security violation|dynamic import/);

    const untilTest = await bash.execute({ script: "i=0; until [ $i -ge 1 ]; do echo until-$i; i=$((i + 1)); done" });
    expect(untilTest.exit_code).toBe(1);
    expect(untilTest.stderr).toMatch(/security violation|dynamic import/);

    const symlink = await bash.execute({ cwd: "/project", script: "ln -s data/input.txt data/input-link" });
    expect(symlink.exit_code).not.toBe(0);
    expect(symlink.stderr).toMatch(/not allowed|hard link not allowed|EPERM|failed/i);
  }, 60_000);

  async function createBashTool(input: {
    timeoutMs: number;
    maxOutputChars: number;
  }): Promise<BashToolForTests> {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-bash-coverage-"));
    tempDirs.push(workspaceRoot);
    const config = loadTestConfig({
      BASH_WORKSPACE_ROOT: workspaceRoot,
      BASH_TIMEOUT_MS: input.timeoutMs,
      BASH_MAX_OUTPUT_CHARS: input.maxOutputChars,
    });
    const user = await repos.users.ensure({ tgId: 860, firstName: "BashCoverage", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    return buildToolRegistry({ config, db, repos, user, thread }).bash as unknown as BashToolForTests;
  }
});

function assertBashCase(name: string, result: BashResultForTests, testCase: CommandCase): void {
  const expectedExit = testCase.exitCode ?? 0;
  expect(result.timed_out, `${name} timed out: ${JSON.stringify(result)}`).toBe(false);
  expect(result.exit_code, `${name} exit: ${JSON.stringify(result)}`).toBe(expectedExit);
  if (testCase.stdout !== undefined) assertText(`${name} stdout`, result.stdout, testCase.stdout);
  if (testCase.stderr !== undefined) assertText(`${name} stderr`, result.stderr, testCase.stderr);
}

function assertText(label: string, actual: string, expected: string | RegExp): void {
  if (typeof expected === "string") expect(actual, label).toBe(expected);
  else expect(actual, label).toMatch(expected);
}

async function withMockFetch<T>(mockFetch: typeof globalThis.fetch, action: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
