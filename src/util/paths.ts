import path from "node:path";

export function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
