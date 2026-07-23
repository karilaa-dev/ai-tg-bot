import fs, { constants } from "node:fs/promises";
import path from "node:path";

export async function copySandboxFileToOutbox(input: {
  userRoot: string;
  sourcePath: string;
  destinationPath: string;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<void> {
  const userRoot = await fs.realpath(path.resolve(input.userRoot));
  const source = path.resolve(input.sourcePath);
  if (!pathContains(userRoot, source)) throw new Error("file path is outside the user sandbox root");
  throwIfAborted(input.signal);

  let sourceHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let destinationHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let destinationCreated = false;
  let failure: unknown;
  try {
    sourceHandle = await fs.open(
      source,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const openedPath = await fs.realpath(`/proc/self/fd/${sourceHandle.fd}`);
    if (!pathContains(userRoot, openedPath)) throw new Error("file path escapes the user sandbox root");
    const stat = await sourceHandle.stat();
    if (!stat.isFile()) throw new Error("path is not a regular file");
    if (stat.size > input.maxBytes) throw new Error("file is larger than the allowed limit");

    destinationHandle = await fs.open(input.destinationPath, "wx", 0o600);
    destinationCreated = true;
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, input.maxBytes + 1));
    let total = 0;
    while (total <= input.maxBytes) {
      throwIfAborted(input.signal);
      const remaining = input.maxBytes + 1 - total;
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        throwIfAborted(input.signal);
        const { bytesWritten } = await destinationHandle.write(buffer, offset, bytesRead - offset);
        offset += bytesWritten;
      }
      total += bytesRead;
    }
    if (total > input.maxBytes) throw new Error("file is larger than the allowed limit");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (destinationHandle) {
      try {
        await destinationHandle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (sourceHandle) {
      try {
        await sourceHandle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (failure !== undefined && destinationCreated) {
      try {
        await fs.unlink(input.destinationPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) {
      if (failure !== undefined) throw new AggregateError([failure, ...cleanupErrors], "sandbox file export and cleanup failed");
      throw new AggregateError(cleanupErrors, "sandbox file export cleanup failed");
    }
  }
}

function pathContains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Tool execution aborted", "AbortError");
}
