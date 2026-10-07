#!/usr/bin/env bun
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMemo } from "./index.js";

const requested = process.env.MEMORY_DIR || "~/.optmem/memory";
const directory = requested === "~" ? os.homedir()
  : requested.startsWith("~/") ? path.join(os.homedir(), requested.slice(2)) : requested;
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const result = await runMemo({
  directory,
  args: process.argv.slice(2),
  command: `${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))}`,
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exit_code;
