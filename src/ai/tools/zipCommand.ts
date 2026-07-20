import path from "node:path";
import { zipSync, type ZipOptions, type Zippable } from "fflate";
import { defineCommand, type CommandContext, type ExecResult } from "just-bash";

const MAX_ZIP_ENTRIES = 10_000;
const MAX_ZIP_INPUT_BYTES = 100 * 1024 * 1024;

type ParsedZipArgs = {
  archive: string;
  sources: string[];
  recursive: boolean;
  quiet: boolean;
  junkPaths: boolean;
  level: ZipOptions["level"];
};

export const zipCommand = defineCommand("zip", async (args, ctx) => {
  if (args.includes("--help") || args.includes("-h")) return success(ZIP_HELP);

  const parsed = parseZipArgs(args);
  if (typeof parsed === "string") return failure(parsed);
  const options = parsed;

  const archivePath = ctx.fs.resolvePath(ctx.cwd, options.archive);
  const entries: Zippable = Object.create(null) as Zippable;
  const entrySources = new Map<string, string>();
  let entryCount = 0;
  let inputBytes = 0;

  try {
    for (const source of options.sources) {
      const sourcePath = ctx.fs.resolvePath(ctx.cwd, source);
      const sourceStat = await ctx.fs.lstat(sourcePath);
      if (sourceStat.isSymbolicLink) throw new Error(`symbolic links are not supported: ${source}`);

      const baseName = archiveBaseName(source, sourcePath, ctx.cwd, options.junkPaths);
      if (sourceStat.isDirectory) {
        if (!options.recursive) throw new Error(`directory requires -r: ${source}`);
        await addDirectory(sourcePath, baseName);
      } else if (sourceStat.isFile) {
        await addFile(sourcePath, baseName || path.posix.basename(sourcePath), sourceStat);
      } else {
        throw new Error(`unsupported file type: ${source}`);
      }
    }

    if (entryCount === 0) throw new Error("nothing to do");
    const archive = zipSync(entries, { level: options.level });
    await ctx.fs.writeFile(archivePath, archive);
    return success(options.quiet ? "" : `  adding: ${entryCount} entr${entryCount === 1 ? "y" : "ies"}\n`);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  async function addDirectory(directoryPath: string, entryName: string): Promise<void> {
    assertNotAborted(ctx);
    if (directoryPath === archivePath) return;

    const names = (await ctx.fs.readdir(directoryPath)).sort();
    if (entryName) addEntry(`${stripTrailingSlashes(entryName)}/`, directoryPath, new Uint8Array(), {
      level: 0,
      mtime: (await ctx.fs.stat(directoryPath)).mtime,
    });
    for (const name of names) {
      const childPath = path.posix.join(directoryPath, name);
      if (childPath === archivePath) continue;
      const childStat = await ctx.fs.lstat(childPath);
      if (childStat.isSymbolicLink) throw new Error(`symbolic links are not supported: ${childPath}`);
      const childEntry = options.junkPaths
        ? name
        : entryName ? `${stripTrailingSlashes(entryName)}/${name}` : name;
      if (childStat.isDirectory) await addDirectory(childPath, childEntry);
      else if (childStat.isFile) await addFile(childPath, childEntry, childStat);
      else throw new Error(`unsupported file type: ${childPath}`);
    }
  }

  async function addFile(filePath: string, entryName: string, stat: Awaited<ReturnType<CommandContext["fs"]["stat"]>>): Promise<void> {
    assertNotAborted(ctx);
    if (filePath === archivePath) return;
    inputBytes += stat.size;
    if (inputBytes > MAX_ZIP_INPUT_BYTES) throw new Error("input exceeds the 100 MB zip limit");
    const bytes = await ctx.fs.readFileBuffer(filePath);
    addEntry(entryName, filePath, bytes, { level: options.level, mtime: stat.mtime });
  }

  function addEntry(entryName: string, sourcePath: string, bytes: Uint8Array, options: ZipOptions): void {
    const safeName = sanitizeEntryName(entryName);
    const existing = entrySources.get(safeName);
    if (existing) {
      if (existing === sourcePath) return;
      throw new Error(`multiple inputs produce the same archive path: ${safeName}`);
    }
    entryCount += 1;
    if (entryCount > MAX_ZIP_ENTRIES) throw new Error(`archive exceeds the ${MAX_ZIP_ENTRIES}-entry limit`);
    entrySources.set(safeName, sourcePath);
    entries[safeName] = [bytes, options];
  }
});

function parseZipArgs(args: string[]): ParsedZipArgs | string {
  let recursive = false;
  let quiet = false;
  let junkPaths = false;
  let level: ZipOptions["level"] = 6;
  let optionsEnded = false;
  const operands: string[] = [];

  for (const arg of args) {
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-") && arg !== "-") {
      if (arg === "--recurse-paths") recursive = true;
      else if (arg === "--quiet") quiet = true;
      else if (arg === "--junk-paths") junkPaths = true;
      else if (arg.startsWith("--")) return `unsupported option: ${arg}`;
      else {
        for (const flag of arg.slice(1)) {
          if (flag === "r") recursive = true;
          else if (flag === "q") quiet = true;
          else if (flag === "j") junkPaths = true;
          else if (/^[0-9]$/.test(flag)) level = Number(flag) as ZipOptions["level"];
          else return `unsupported option: -${flag}`;
        }
      }
      continue;
    }
    operands.push(arg);
  }

  if (operands.length < 2) return "usage: zip [-rjq0-9] archive.zip path ...";
  return {
    archive: operands[0]!,
    sources: operands.slice(1),
    recursive,
    quiet,
    junkPaths,
    level,
  };
}

function archiveBaseName(source: string, sourcePath: string, cwd: string, junkPaths: boolean): string {
  if (junkPaths) return path.posix.basename(sourcePath);
  const normalized = path.posix.normalize(source);
  if (normalized === ".") return "";
  if (path.posix.isAbsolute(normalized)) return normalized.replace(/^\/+/, "");
  const relative = path.posix.relative(cwd, sourcePath);
  return relative.split("/").filter((part) => part && part !== "..").join("/") || path.posix.basename(sourcePath);
}

function sanitizeEntryName(name: string): string {
  const directory = name.endsWith("/");
  const safe = path.posix.normalize(name)
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  if (!safe) throw new Error("invalid empty archive path");
  return directory ? `${safe}/` : safe;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function assertNotAborted(ctx: CommandContext): void {
  if (ctx.signal?.aborted) throw ctx.signal.reason ?? new DOMException("Tool execution aborted", "AbortError");
}

function success(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function failure(message: string): ExecResult {
  return { stdout: "", stderr: `zip error: ${message}\n`, exitCode: 1 };
}

const ZIP_HELP = `Usage: zip [options] archive.zip path ...
  -r, --recurse-paths  include directories recursively
  -j, --junk-paths     store file names without directory paths
  -q, --quiet          suppress normal output
  -0 through -9        set compression level
`;
