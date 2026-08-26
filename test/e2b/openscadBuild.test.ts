import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const wrapper = path.resolve("e2b-template/assets/openscad-build");
let tempRoot: string;
let binDir: string;
let modelDir: string;
let modelPath: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openscad-build-test-"));
  binDir = path.join(tempRoot, "bin");
  modelDir = path.join(tempRoot, "model folder");
  modelPath = path.join(modelDir, "model.scad");
  await fs.mkdir(binDir);
  await fs.mkdir(modelDir);
  await fs.writeFile(modelPath, "cube([1, 1, 1]);\n");
  await writeExecutable(path.join(binDir, "xvfb-run"), `#!/usr/bin/env bash
set -euo pipefail
[[ "\${1:-}" == "-a" ]] && shift
exec "$@"
`);
  await writeExecutable(path.join(binDir, "openscad"), `#!/usr/bin/env bash
set -euo pipefail
output=""
render_mode="mesh"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then
    output="$2"
    shift 2
    continue
  fi
  if [[ "$1" == "--render" ]]; then
    render_mode="exact"
  fi
  if [[ "$1" == "--preview=throwntogether" ]]; then
    render_mode="preview"
  fi
  shift
done
extension="\${output##*.}"
if [[ "\${OPENSCAD_STUB_FAIL_EXTENSION:-}" == "$extension" ]]; then
  printf 'stub failure for %s\n' "$extension" >&2
  exit 1
fi
printf 'rendered %s %s\n' "$extension" "$render_mode" > "$output"
if [[ "\${OPENSCAD_STUB_ERROR_EXTENSION:-}" == "$extension" ]]; then
  printf 'ERROR: stub reported an error for %s\n' "$extension" >&2
fi
`);
  await writeExecutable(path.join(binDir, "mv"), `#!/usr/bin/env bash
set -euo pipefail
destination="\${!#}"
if [[ -n "\${OPENSCAD_STUB_FAIL_MOVE_DEST:-}" \
  && "$destination" == "$OPENSCAD_STUB_FAIL_MOVE_DEST" \
  && ! -e "\${OPENSCAD_STUB_MOVE_MARKER:?}" ]]; then
  : > "$OPENSCAD_STUB_MOVE_MARKER"
  printf 'stub move failure for %s\n' "$destination" >&2
  exit 1
fi
exec /usr/bin/mv "$@"
`);
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("openscad-build", () => {
  it("atomically creates the fast preview beside the SCAD source", async () => {
    const result = await runWrapper("preview");

    const preview = path.join(modelDir, "model.preview.png");
    expect(result.stdout.trim()).toBe(`preview_png=${preview}`);
    expect(await fs.readFile(preview, "utf8")).toBe("rendered png preview\n");
  });

  it("creates STL, 3MF, and exact PNG outputs in final mode", async () => {
    const result = await runWrapper("final");

    expect(result.stdout).toContain(`scad=${modelPath}`);
    expect(result.stdout).toContain(`stl=${path.join(modelDir, "model.stl")}`);
    expect(result.stdout).toContain(`3mf=${path.join(modelDir, "model.3mf")}`);
    expect(result.stdout).toContain(`final_png=${path.join(modelDir, "model.final.png")}`);
    await expect(fs.readFile(path.join(modelDir, "model.stl"), "utf8")).resolves.toBe("rendered stl mesh\n");
    await expect(fs.readFile(path.join(modelDir, "model.3mf"), "utf8")).resolves.toBe("rendered 3mf mesh\n");
    await expect(fs.readFile(path.join(modelDir, "model.final.png"), "utf8")).resolves.toBe("rendered png exact\n");
  });

  it("preserves all previous final outputs when one staged export fails", async () => {
    const targets = ["model.stl", "model.3mf", "model.final.png"];
    await Promise.all(targets.map((name) => fs.writeFile(path.join(modelDir, name), `old ${name}\n`)));

    await expect(runWrapper("final", { OPENSCAD_STUB_FAIL_EXTENSION: "3mf" }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("3mf failed") });

    for (const name of targets) {
      await expect(fs.readFile(path.join(modelDir, name), "utf8")).resolves.toBe(`old ${name}\n`);
    }
  });

  it("restores all previous final outputs when replacement fails partway", async () => {
    const targets = ["model.stl", "model.3mf", "model.final.png"];
    await Promise.all(targets.map((name) => fs.writeFile(path.join(modelDir, name), `old ${name}\n`)));

    await expect(runWrapper("final", {
      OPENSCAD_STUB_FAIL_MOVE_DEST: path.join(modelDir, "model.3mf"),
      OPENSCAD_STUB_MOVE_MARKER: path.join(tempRoot, "move-failed"),
    })).rejects.toMatchObject({ stderr: expect.stringContaining("stub move failure") });

    for (const name of targets) {
      await expect(fs.readFile(path.join(modelDir, name), "utf8")).resolves.toBe(`old ${name}\n`);
    }
  });

  it("rejects a reported OpenSCAD error even when the process exits successfully", async () => {
    const preview = path.join(modelDir, "model.preview.png");
    await fs.writeFile(preview, "old preview\n");

    await expect(runWrapper("preview", { OPENSCAD_STUB_ERROR_EXTENSION: "png" }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("reported an OpenSCAD error") });
    await expect(fs.readFile(preview, "utf8")).resolves.toBe("old preview\n");
  });
});

async function runWrapper(mode: "preview" | "final", extraEnv: NodeJS.ProcessEnv = {}) {
  return execFileAsync("bash", [wrapper, mode, modelPath], {
    env: { ...process.env, ...extraEnv, PATH: `${binDir}:${process.env.PATH ?? ""}` },
  });
}

async function writeExecutable(filePath: string, contents: string): Promise<void> {
  await fs.writeFile(filePath, contents, { mode: 0o755 });
}
