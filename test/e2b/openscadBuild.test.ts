import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const wrapper = path.resolve("e2b-template/assets/openscad-build");
const povRenderer = path.resolve("e2b-template/assets/openscad-pov-render.mjs");
let tempRoot: string;
let binDir: string;
let modelDir: string;
let modelPath: string;
let openscadArgsLog: string;
let povrayArgsLog: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openscad-build-test-"));
  binDir = path.join(tempRoot, "bin");
  modelDir = path.join(tempRoot, "model folder");
  modelPath = path.join(modelDir, "model.scad");
  openscadArgsLog = path.join(tempRoot, "openscad-args.log");
  povrayArgsLog = path.join(tempRoot, "povray-args.log");
  await fs.mkdir(binDir);
  await fs.mkdir(modelDir);
  await fs.writeFile(modelPath, "cube([1, 1, 1]);\n");
  await writeExecutable(path.join(binDir, "openscad"), openscadStub);
  await writeExecutable(path.join(binDir, "povray"), povrayStub);
  await writeExecutable(path.join(binDir, "magick"), magickStub);
  await writeExecutable(path.join(binDir, "mv"), moveStub);
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("openscad-build", () => {
  it("creates a 900x675 fast preview with one OpenSCAD evaluation", async () => {
    const sceneCapture = path.join(tempRoot, "preview-scene.pov");
    const result = await runWrapper("preview", { POVRAY_STUB_SCENE_CAPTURE: sceneCapture });

    const preview = path.join(modelDir, "model.preview.png");
    expect(result.stdout.trim()).toBe(`preview_png=${preview}`);
    expect(await fs.readFile(preview, "utf8")).toBe("rendered png 900x675\n");
    const openscadCalls = await readLogLines(openscadArgsLog);
    expect(openscadCalls).toHaveLength(1);
    expect(openscadCalls[0]).toContain("-D $preview=true");
    expect(openscadCalls[0]?.match(/ -o /gu)).toHaveLength(2);
    expect(await fs.readFile(povrayArgsLog, "utf8")).toContain("+W900 +H675");
    expect(await fs.readFile(povrayArgsLog, "utf8")).toContain("+Q5 -A");
    const scene = await fs.readFile(sceneCapture, "utf8");
    expect(scene).toContain("union {");
    expect(scene).toContain("perspective");
    expect(scene).not.toContain("rad_def.inc");
  });

  it("creates a binary STL and 1200x900 PNG with one OpenSCAD evaluation", async () => {
    const result = await runWrapper("final");

    expect(result.stdout).toContain(`stl=${path.join(modelDir, "model.stl")}`);
    expect(result.stdout).toContain(`final_png=${path.join(modelDir, "model.final.png")}`);
    expect(result.stdout).not.toContain("scad=");
    expect(result.stdout).not.toContain("3mf=");
    const stl = await fs.readFile(path.join(modelDir, "model.stl"));
    expect(stl.subarray(0, 14).toString("ascii")).toBe("OpenSCAD Model");
    expect(stl.readUInt32LE(80)).toBe(1);
    expect(stl).toHaveLength(134);
    await expect(fs.access(path.join(modelDir, "model.3mf"))).rejects.toThrow();
    await expect(fs.readFile(path.join(modelDir, "model.final.png"), "utf8")).resolves.toBe("rendered png 1200x900\n");
    const openscadCalls = await readLogLines(openscadArgsLog);
    expect(openscadCalls).toHaveLength(1);
    expect(openscadCalls[0]?.match(/ -o /gu)).toHaveLength(2);
    expect(openscadCalls[0]).toContain(".binstl");
    expect(openscadCalls[0]).not.toContain(".3mf");
    expect(await fs.readFile(povrayArgsLog, "utf8")).toContain("+W1200 +H900");
    expect(await fs.readFile(povrayArgsLog, "utf8")).toContain("+Q7 +A0.2 +AM2 +R3");
  });

  it("preserves all previous final outputs when a staged OpenSCAD export fails", async () => {
    await writeOldFinalOutputs();

    await expect(runWrapper("final", { OPENSCAD_STUB_FAIL_EXTENSION: "binstl" }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("final failed") });

    await expectOldFinalOutputs();
  });

  it("preserves all previous final outputs when POV-Ray fails", async () => {
    await writeOldFinalOutputs();

    await expect(runWrapper("final", { POVRAY_STUB_FAIL: "1" }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("final_png render failed") });

    await expectOldFinalOutputs();
  });

  it("restores all previous final outputs when replacement fails partway", async () => {
    await writeOldFinalOutputs();

    await expect(runWrapper("final", {
      OPENSCAD_STUB_FAIL_MOVE_DEST: path.join(modelDir, "model.final.png"),
      OPENSCAD_STUB_MOVE_MARKER: path.join(tempRoot, "move-failed"),
    })).rejects.toMatchObject({ stderr: expect.stringContaining("stub move failure") });

    await expectOldFinalOutputs();
  });

  it("rejects a reported OpenSCAD error and preserves the previous preview", async () => {
    const preview = path.join(modelDir, "model.preview.png");
    await fs.writeFile(preview, "old preview\n");

    await expect(runWrapper("preview", { OPENSCAD_STUB_REPORT_ERROR: "1" }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("reported an OpenSCAD error") });
    await expect(fs.readFile(preview, "utf8")).resolves.toBe("old preview\n");
  });

  it("rejects invalid geometry summaries and malformed rendered images", async () => {
    await expect(runWrapper("preview", { OPENSCAD_STUB_INVALID_GEOMETRY: "1" }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("three-dimensional geometry") });
    await expect(runWrapper("preview", { MAGICK_STUB_INVALID: "1" }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("unexpected image properties") });
  });

  it("rejects malformed and oversized binary STL outputs before rendering", async () => {
    await expect(runWrapper("final", { OPENSCAD_STUB_INVALID_BINARY_STL: "1" }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("binary STL is too short") });
    await expect(runWrapper("final", { OPENSCAD_STUB_OVERSIZED_BINARY_STL: "1" }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("above the 20971520-byte delivery limit") });
    await expect(fs.access(povrayArgsLog)).rejects.toThrow();
  });
});

describe("OpenSCAD POV scene renderer", () => {
  it("uses a deterministic neutral isometric scene and strips generated lights", async () => {
    const input = path.join(tempRoot, "input.pov");
    const summary = path.join(tempRoot, "summary.json");
    const output = path.join(tempRoot, "output.pov");
    await fs.writeFile(input, rawPov);
    await fs.writeFile(summary, JSON.stringify(validSummary));

    await execFileAsync("node", [povRenderer, input, summary, output]);

    const scene = await fs.readFile(output, "utf8");
    expect(scene).toContain("background { color rgb <0.96, 0.97, 0.985> }");
    expect(scene).toContain("color rgb <0.72, 0.80, 0.90>");
    expect(scene).toContain("angle 34");
    expect(scene.match(/^light_source/gmu)).toHaveLength(2);
    expect(scene).not.toContain("<99, 99, 99>");
    expect(scene).not.toContain("rad_def.inc");
  });

  it("rejects malformed summaries and dimensionless geometry", async () => {
    const input = path.join(tempRoot, "input.pov");
    const summary = path.join(tempRoot, "summary.json");
    const output = path.join(tempRoot, "output.pov");
    await fs.writeFile(input, rawPov);
    await fs.writeFile(summary, "not-json");
    await expect(execFileAsync("node", [povRenderer, input, summary, output]))
      .rejects.toMatchObject({ stderr: expect.stringContaining("not valid JSON") });

    await fs.writeFile(summary, JSON.stringify({
      geometry: { dimensions: 2, bounding_box: { min: [0, 0, 0], max: [1, 1, 0], size: [1, 1, 0] } },
    }));
    await expect(execFileAsync("node", [povRenderer, input, summary, output]))
      .rejects.toMatchObject({ stderr: expect.stringContaining("three-dimensional geometry") });
  });
});

async function runWrapper(mode: "preview" | "final", extraEnv: NodeJS.ProcessEnv = {}) {
  return execFileAsync("bash", [wrapper, mode, modelPath], {
    env: {
      ...process.env,
      OPENSCAD_POV_RENDERER: povRenderer,
      OPENSCAD_STUB_ARGS_LOG: openscadArgsLog,
      POVRAY_STUB_ARGS_LOG: povrayArgsLog,
      ...extraEnv,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
}

async function writeOldFinalOutputs(): Promise<void> {
  await Promise.all(["model.stl", "model.final.png"]
    .map((name) => fs.writeFile(path.join(modelDir, name), `old ${name}\n`)));
}

async function expectOldFinalOutputs(): Promise<void> {
  for (const name of ["model.stl", "model.final.png"]) {
    await expect(fs.readFile(path.join(modelDir, name), "utf8")).resolves.toBe(`old ${name}\n`);
  }
}

async function readLogLines(filePath: string): Promise<string[]> {
  return (await fs.readFile(filePath, "utf8")).trim().split("\n").filter(Boolean);
}

async function writeExecutable(filePath: string, contents: string): Promise<void> {
  await fs.writeFile(filePath, contents, { mode: 0o755 });
}

const validSummary = {
  geometry: {
    dimensions: 3,
    facets: 12,
    bounding_box: { min: [-10, -5, 0], max: [10, 5, 30], size: [20, 10, 30] },
  },
};

const rawPov = `// generated scene
#version 3.7;
#declare MATERIAL=finish { specular 0.5 }
#declare MATERIAL_INT=interior { ior 1.32 }
polygon { 4,
<0, 0, 0>, <1, 0, 0>, <0, 1, 0>, <0, 0, 0>
texture { pigment { color rgbf <1, 0, 0, 0> } }
finish { MATERIAL } interior { MATERIAL_INT }
}
light_source { <99, 99, 99> color rgb <1, 1, 1> }
camera { location <0, 0, 100> look_at <0, 0, 0> }
#include "rad_def.inc"
`;

const openscadStub = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${OPENSCAD_STUB_ARGS_LOG:?}"
summary=""
outputs=()
mode=final
while [[ $# -gt 0 ]]; do
  case "$1" in
    --summary-file) summary="$2"; shift 2 ;;
    -o) outputs+=("$2"); shift 2 ;;
    -D) [[ "$2" == '\$preview=true' ]] && mode=preview; shift 2 ;;
    *) shift ;;
  esac
done
for output in "\${outputs[@]}"; do
  extension="\${output##*.}"
  if [[ "\${OPENSCAD_STUB_FAIL_EXTENSION:-}" == "$extension" ]]; then
    printf 'stub failure for %s\\n' "$extension" >&2
    exit 1
  fi
  if [[ "$extension" == pov ]]; then
    cat > "$output" <<'POV'
${rawPov}POV
  elif [[ "$extension" == binstl ]]; then
    node - "$output" <<'NODE'
const fs = require("node:fs");
const output = process.argv[2];
if (process.env.OPENSCAD_STUB_INVALID_BINARY_STL === "1") {
  fs.writeFileSync(output, Buffer.from("invalid"));
  process.exit(0);
}
const limit = 20 * 1024 * 1024;
const triangles = process.env.OPENSCAD_STUB_OVERSIZED_BINARY_STL === "1"
  ? Math.floor((limit - 84) / 50) + 1
  : 1;
const bytes = Buffer.alloc(84 + triangles * 50);
Buffer.from("OpenSCAD Model\\n").copy(bytes);
bytes.writeUInt32LE(triangles, 80);
fs.writeFileSync(output, bytes);
NODE
  else
    printf 'rendered %s %s\\n' "$extension" "$mode" > "$output"
  fi
done
if [[ "\${OPENSCAD_STUB_INVALID_GEOMETRY:-}" == 1 ]]; then
  printf '%s' '{"geometry":{"dimensions":2,"bounding_box":{"min":[0,0,0],"max":[1,1,0],"size":[1,1,0]}}}' > "$summary"
else
  printf '%s' '${JSON.stringify(validSummary)}' > "$summary"
fi
if [[ "\${OPENSCAD_STUB_REPORT_ERROR:-}" == 1 ]]; then
  printf 'ERROR: stub reported an error\\n' >&2
fi
`;

const povrayStub = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${POVRAY_STUB_ARGS_LOG:?}"
input=""
output=""
width=""
height=""
for argument in "$@"; do
  case "$argument" in
    +I*) input="\${argument#+I}" ;;
    +O*) output="\${argument#+O}" ;;
    +W*) width="\${argument#+W}" ;;
    +H*) height="\${argument#+H}" ;;
  esac
done
if [[ "\${POVRAY_STUB_FAIL:-}" == 1 ]]; then
  printf 'stub POV-Ray failure\\n' >&2
  exit 1
fi
if [[ -n "\${POVRAY_STUB_SCENE_CAPTURE:-}" ]]; then
  cp "$input" "$POVRAY_STUB_SCENE_CAPTURE"
fi
printf 'rendered png %sx%s\\n' "$width" "$height" > "$output"
`;

const magickStub = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${MAGICK_STUB_INVALID:-}" == 1 ]]; then
  printf 'JPEG 1 1'
  exit 0
fi
input="\${!#}"
dimensions="$(sed -n 's/^rendered png \\([0-9][0-9]*\\)x\\([0-9][0-9]*\\)$/\\1 \\2/p' "$input")"
[[ -n "$dimensions" ]]
printf 'PNG %s' "$dimensions"
`;

const moveStub = `#!/usr/bin/env bash
set -euo pipefail
destination="\${!#}"
if [[ -n "\${OPENSCAD_STUB_FAIL_MOVE_DEST:-}" \
  && "$destination" == "$OPENSCAD_STUB_FAIL_MOVE_DEST" \
  && ! -e "\${OPENSCAD_STUB_MOVE_MARKER:?}" ]]; then
  : > "$OPENSCAD_STUB_MOVE_MARKER"
  printf 'stub move failure for %s\\n' "$destination" >&2
  exit 1
fi
exec /usr/bin/mv "$@"
`;
