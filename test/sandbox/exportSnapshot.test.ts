import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { copySandboxFileToOutbox } from "../../src/sandbox/exportSnapshot.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("copySandboxFileToOutbox", () => {
  it("copies a bounded regular file with private permissions", async () => {
    const root = await tempRoot();
    const source = path.join(root, "users", "1", "file.txt");
    const destination = path.join(root, "outbox", "content");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(source, "hello");

    await copySandboxFileToOutbox({
      userRoot: path.join(root, "users", "1"),
      sourcePath: source,
      destinationPath: destination,
      maxBytes: 10,
    });

    await expect(fs.readFile(destination, "utf8")).resolves.toBe("hello");
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
  });

  it("rejects final and intermediate symlink escapes", async () => {
    const root = await tempRoot();
    const userRoot = path.join(root, "users", "1");
    const outside = path.join(root, "outside.txt");
    const destination = path.join(root, "outbox", "content");
    await fs.mkdir(userRoot, { recursive: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(outside, "secret");
    await fs.symlink(outside, path.join(userRoot, "final-link"));
    await fs.symlink(root, path.join(userRoot, "dir-link"));

    await expect(copySandboxFileToOutbox({
      userRoot,
      sourcePath: path.join(userRoot, "final-link"),
      destinationPath: destination,
      maxBytes: 100,
    })).rejects.toThrow();
    await expect(copySandboxFileToOutbox({
      userRoot,
      sourcePath: path.join(userRoot, "dir-link", "outside.txt"),
      destinationPath: destination,
      maxBytes: 100,
    })).rejects.toThrow("escapes");
  });

  it("removes partial output when the byte limit is exceeded", async () => {
    const root = await tempRoot();
    const source = path.join(root, "users", "1", "large.bin");
    const destination = path.join(root, "outbox", "content");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(source, Buffer.alloc(32));

    await expect(copySandboxFileToOutbox({
      userRoot: path.join(root, "users", "1"),
      sourcePath: source,
      destinationPath: destination,
      maxBytes: 16,
    })).rejects.toThrow("larger");
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects directories and existing destinations", async () => {
    const root = await tempRoot();
    const userRoot = path.join(root, "users", "1");
    const source = path.join(userRoot, "file.txt");
    const directory = path.join(userRoot, "directory");
    const destination = path.join(root, "outbox", "content");
    await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(source, "new");

    await expect(copySandboxFileToOutbox({
      userRoot,
      sourcePath: directory,
      destinationPath: destination,
      maxBytes: 100,
    })).rejects.toThrow("regular file");

    await fs.writeFile(destination, "existing");
    await expect(copySandboxFileToOutbox({
      userRoot,
      sourcePath: source,
      destinationPath: destination,
      maxBytes: 100,
    })).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("existing");
  });

  it("rejects a FIFO without waiting for a writer", async () => {
    const root = await tempRoot();
    const userRoot = path.join(root, "users", "1");
    const fifo = path.join(userRoot, "pipe");
    const destination = path.join(root, "outbox", "content");
    await fs.mkdir(userRoot, { recursive: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await execFileAsync("mkfifo", [fifo]);

    await expect(copySandboxFileToOutbox({
      userRoot,
      sourcePath: fifo,
      destinationPath: destination,
      maxBytes: 100,
    })).rejects.toThrow("regular file");
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors an already-aborted signal without creating output", async () => {
    const root = await tempRoot();
    const userRoot = path.join(root, "users", "1");
    const source = path.join(userRoot, "file.txt");
    const destination = path.join(root, "outbox", "content");
    await fs.mkdir(userRoot, { recursive: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(source, "hello");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(copySandboxFileToOutbox({
      userRoot,
      sourcePath: source,
      destinationPath: destination,
      maxBytes: 100,
      signal: controller.signal,
    })).rejects.toThrow("cancelled");
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-export-test-"));
  roots.push(root);
  return root;
}
