#!/usr/bin/env node

import fs from "node:fs/promises";

const [, , inputPath, summaryPath, outputPath] = process.argv;
if (!inputPath || !summaryPath || !outputPath || process.argv.length !== 5) {
  console.error("Usage: openscad-pov-render INPUT.pov SUMMARY.json OUTPUT.pov");
  process.exit(2);
}

const [input, summaryText] = await Promise.all([
  fs.readFile(inputPath, "utf8"),
  fs.readFile(summaryPath, "utf8"),
]);

let summary;
try {
  summary = JSON.parse(summaryText);
} catch {
  throw new Error("OpenSCAD summary is not valid JSON.");
}

const geometry = summary?.geometry;
const boundingBox = geometry?.bounding_box;
const min = finiteVector(boundingBox?.min, "minimum bounding-box corner");
const max = finiteVector(boundingBox?.max, "maximum bounding-box corner");
const size = finiteVector(boundingBox?.size, "bounding-box size");
if (geometry?.dimensions !== 3 || size.some((value) => value <= 0)) {
  throw new Error("OpenSCAD model must contain non-empty three-dimensional geometry.");
}

const polygonStart = input.search(/^polygon\s*\{/mu);
const generatedSceneStart = firstIndex(input, [
  /^light_source\s*\{/mu,
  /^camera\s*\{/mu,
  /^#include\s+"rad_def\.inc"/mu,
]);
if (polygonStart < 0 || generatedSceneStart < 0 || generatedSceneStart <= polygonStart) {
  throw new Error("OpenSCAD POV output does not contain the expected polygon scene.");
}

const polygons = input
  .slice(polygonStart, generatedSceneStart)
  .trim()
  .split("\n")
  .map((line) => line.startsWith("texture { pigment { color ")
    ? "texture { pigment { color rgb <0.72, 0.80, 0.90> } }"
    : line)
  .join("\n");

const center = min.map((value, index) => (value + max[index]) / 2);
const radius = Math.hypot(...size.map((value) => value / 2));
if (!Number.isFinite(radius) || radius <= 0) {
  throw new Error("OpenSCAD model has an invalid bounding-box radius.");
}

const direction = normalize([1.35, -1.55, 1.05]);
const horizontalFovDegrees = 34;
const aspectRatio = 4 / 3;
const horizontalHalfAngle = degreesToRadians(horizontalFovDegrees / 2);
const verticalHalfAngle = Math.atan(Math.tan(horizontalHalfAngle) / aspectRatio);
const cameraDistance = 1.25 * radius / Math.sin(verticalHalfAngle);
const camera = center.map((value, index) => value + direction[index] * cameraDistance);
const lightDistance = Math.max(radius, 1);
const keyLight = add(center, scale([-2.4, -3.0, 4.2], lightDistance));
const fillLight = add(center, scale([3.4, 1.8, 1.8], lightDistance));
const areaSize = Math.max(radius * 1.1, 1);

const output = `// Normalized by openscad-build for deterministic headless rendering.
#version 3.7;
global_settings { assumed_gamma 1.0 max_trace_level 10 }
background { color rgb <0.96, 0.97, 0.985> }
#declare MATERIAL=finish { ambient 0.16 diffuse 0.72 specular 0.22 roughness 0.08 }
#declare MATERIAL_INT=interior { ior 1.0 }

union {
${polygons}
}

camera {
  perspective
  location ${vector(camera)}
  sky <0, 0, 1>
  right x*image_width/image_height
  up y
  angle ${horizontalFovDegrees}
  look_at ${vector(center)}
}

light_source {
  ${vector(keyLight)}
  color rgb <0.88, 0.91, 1.0>
  area_light <${format(areaSize)}, 0, 0>, <0, ${format(areaSize)}, 0>, 5, 5
  adaptive 1 jitter
}
light_source {
  ${vector(fillLight)}
  color rgb <0.44, 0.47, 0.52>
  shadowless
}
`;

await fs.writeFile(outputPath, output, "utf8");

function finiteVector(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => !Number.isFinite(item))) {
    throw new Error(`OpenSCAD summary has an invalid ${label}.`);
  }
  return value;
}

function firstIndex(text, patterns) {
  return patterns.reduce((best, pattern) => {
    const found = text.search(pattern);
    if (found < 0) return best;
    return best < 0 ? found : Math.min(best, found);
  }, -1);
}

function degreesToRadians(value) {
  return value * Math.PI / 180;
}

function normalize(values) {
  const length = Math.hypot(...values);
  return values.map((value) => value / length);
}

function add(left, right) {
  return left.map((value, index) => value + right[index]);
}

function scale(values, amount) {
  return values.map((value) => value * amount);
}

function format(value) {
  const normalized = Math.abs(value) < 1e-9 ? 0 : value;
  return Number(normalized.toFixed(6)).toString();
}

function vector(values) {
  return `<${values.map(format).join(", ")}>`;
}
