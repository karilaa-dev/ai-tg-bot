import { InMemoryFs, type CpOptions, type FileContent, type FsStat, type RmOptions } from "just-bash";

export interface LazyAttachmentEntry {
  id: number;
  size: number;
  createdAt: number;
  load(signal?: AbortSignal): Promise<Buffer | Uint8Array>;
}

type DeclaredMetadata = Pick<FsStat, "mode" | "size" | "mtime">;

export class LazyAttachmentFs extends InMemoryFs {
  private readonly declared = new Map<string, DeclaredMetadata>();

  constructor(entries: LazyAttachmentEntry[], signal?: AbortSignal) {
    super();
    for (const entry of entries) {
      const entryPath = `/${entry.id}`;
      const metadata = {
        mode: 0o444,
        size: entry.size,
        mtime: new Date(entry.createdAt),
      };
      this.declared.set(entryPath, metadata);
      this.writeFileLazy(entryPath, async () => {
        const bytes = await entry.load(signal);
        this.declared.delete(entryPath);
        return bytes;
      }, metadata);
    }
  }

  override async stat(filePath: string): Promise<FsStat> {
    const normalized = this.resolvePath("/", filePath);
    const declared = this.declared.get(normalized);
    if (declared) return { isFile: true, isDirectory: false, isSymbolicLink: false, ...declared };
    return super.stat(filePath);
  }

  override async lstat(filePath: string): Promise<FsStat> {
    const normalized = this.resolvePath("/", filePath);
    const declared = this.declared.get(normalized);
    if (declared) return { isFile: true, isDirectory: false, isSymbolicLink: false, ...declared };
    return super.lstat(filePath);
  }

  override async writeFile(
    filePath: string,
    content: FileContent,
    options?: Parameters<InMemoryFs["writeFile"]>[2],
  ): Promise<void> {
    this.declared.delete(this.resolvePath("/", filePath));
    await super.writeFile(filePath, content, options);
  }

  override async rm(filePath: string, options?: RmOptions): Promise<void> {
    const normalized = this.resolvePath("/", filePath);
    for (const declaredPath of this.declared.keys()) {
      if (declaredPath === normalized || declaredPath.startsWith(`${normalized}/`)) this.declared.delete(declaredPath);
    }
    await super.rm(filePath, options);
  }

  override async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const normalized = this.resolvePath("/", src);
    if (this.declared.has(normalized)) await super.readFileBuffer(src);
    await super.cp(src, dest, options);
  }

  override async mv(src: string, dest: string): Promise<void> {
    const normalizedSource = this.resolvePath("/", src);
    if (this.declared.has(normalizedSource)) await super.readFileBuffer(src);
    await super.mv(src, dest);
  }

  override async link(existingPath: string, newPath: string): Promise<void> {
    const normalized = this.resolvePath("/", existingPath);
    if (this.declared.has(normalized)) await super.readFileBuffer(existingPath);
    await super.link(existingPath, newPath);
  }

  override async chmod(filePath: string, mode: number): Promise<void> {
    const normalized = this.resolvePath("/", filePath);
    const metadata = this.declared.get(normalized);
    if (metadata) metadata.mode = mode;
    await super.chmod(filePath, mode);
  }

  override async utimes(filePath: string, atime: Date, mtime: Date): Promise<void> {
    const normalized = this.resolvePath("/", filePath);
    const metadata = this.declared.get(normalized);
    if (metadata) metadata.mtime = mtime;
    await super.utimes(filePath, atime, mtime);
  }
}
