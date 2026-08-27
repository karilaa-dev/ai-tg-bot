import fs from "node:fs/promises";
import path from "node:path";

const source = path.resolve("e2b-template/assets");
const destination = path.resolve("dist/e2b-template/assets");

await fs.rm(destination, { recursive: true, force: true });
await fs.cp(source, destination, { recursive: true });

for (const name of ["officecli", "openscad-build", "tool-contract.sh"]) {
  const info = await fs.stat(path.join(destination, name));
  if (!info.isFile() || info.size === 0) throw new Error(`Failed to package E2B template asset: ${name}`);
}
