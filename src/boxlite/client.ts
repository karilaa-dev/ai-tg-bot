import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type {
  BoxClient,
  BoxClientProvider,
  BoxCreateOptions,
  BoxExecution,
  BoxHandle,
  BoxInfo,
  BoxInputStream,
  BoxOutputStream,
} from "./types.js";

type BoxliteModule = typeof import("@boxlite-ai/boxlite");
type NativeRuntime = InstanceType<BoxliteModule["JsBoxlite"]>;
type NativeBox = NonNullable<Awaited<ReturnType<NativeRuntime["get"]>>>;
type NativeExecution = Awaited<ReturnType<NativeBox["exec"]>>;

export function createBoxClientProvider(config: AppConfig): BoxClientProvider {
  return createRetryableBoxClientProvider(() => createBoxClient(config));
}

export function createRetryableBoxClientProvider(factory: () => Promise<BoxClient>): BoxClientProvider {
  let client: BoxClient | undefined;
  let pending: Promise<BoxClient> | undefined;
  return async function getClient(): Promise<BoxClient> {
    if (client) {
      return client;
    }

    if (!pending) {
      pending = factory();
    }
    const initialization = pending;
    try {
      client = await initialization;
      return client;
    } finally {
      if (pending === initialization) pending = undefined;
    }
  };
}

export async function createBoxClient(config: AppConfig): Promise<BoxClient> {
  const unavailableReason = process.env.BOXLITE_UNAVAILABLE_REASON?.trim()
    || boxlitePlatformUnavailableReason();
  if (unavailableReason) {
    throw new Error(`BoxLite is unavailable: ${unavailableReason}`);
  }
  const { JsBoxlite } = await import("@boxlite-ai/boxlite");
  return new SdkBoxClient(new JsBoxlite({ homeDir: resolveBoxliteHome(config) }));
}

export function resolveBoxliteHome(config: Pick<AppConfig, "BOXLITE_HOME">): string {
  return path.resolve(config.BOXLITE_HOME);
}

export function boxlitePlatformUnavailableReason(
  platform = process.platform,
  arch = process.arch,
  release = os.release(),
): string | undefined {
  if (platform !== "darwin") return undefined;
  if (arch !== "arm64") {
    return `local macOS BoxLite requires Apple Silicon and an arm64 Node.js process; detected ${platform}/${arch}. Intel Macs and x64 Node under Rosetta are unsupported.`;
  }

  const darwinMajor = Number.parseInt(release.split(".")[0] ?? "", 10);
  if (Number.isFinite(darwinMajor) && darwinMajor < 21) {
    return `local macOS BoxLite requires macOS 12 or later; detected Darwin ${release}.`;
  }
  return undefined;
}

export function formatBoxliteError(error: unknown): string {
  return String(error);
}

class SdkBoxClient implements BoxClient {
  constructor(private readonly runtime: NativeRuntime) {}

  async get(name: string): Promise<BoxHandle | undefined> {
    const box = await this.runtime.get(name);
    return box ? new SdkBoxHandle(box) : undefined;
  }

  async getOrCreate(
    options: BoxCreateOptions,
    name: string,
  ): Promise<{ box: BoxHandle; created: boolean }> {
    const result = await this.runtime.getOrCreate(options, name);
    return {
      box: new SdkBoxHandle(result.box),
      created: result.created,
    };
  }

  async listInfo(): Promise<BoxInfo[]> {
    return (await this.runtime.listInfo()).map(toBoxInfo);
  }

  remove(idOrName: string, force = false): Promise<void> {
    return this.runtime.remove(idOrName, force);
  }

  shutdown(): Promise<void> {
    return this.runtime.shutdown();
  }
}

class SdkBoxHandle implements BoxHandle {
  readonly id: string;
  readonly name?: string;

  constructor(private readonly box: NativeBox) {
    this.id = box.id;
    this.name = box.name ?? undefined;
  }

  info(): BoxInfo {
    return toBoxInfo(this.box.info());
  }

  start(): Promise<void> {
    return this.box.start();
  }

  stop(): Promise<void> {
    return this.box.stop();
  }

  copyOut(containerSource: string, hostDestination: string): Promise<void> {
    return this.box.copyOut(containerSource, hostDestination, {
      recursive: false,
      overwrite: false,
      followSymlinks: false,
    });
  }

  async exec(
    command: string,
    args: string[],
    env: Array<[string, string]>,
    tty: boolean,
    user: string,
    timeoutSecs: number,
    workingDir: string,
  ): Promise<BoxExecution> {
    return new SdkBoxExecution(await this.box.exec(command, args, env, tty, user, timeoutSecs, workingDir));
  }
}

class SdkBoxExecution implements BoxExecution {
  constructor(private readonly execution: NativeExecution) {}

  stdin(): Promise<BoxInputStream> {
    return this.execution.stdin();
  }

  stdout(): Promise<BoxOutputStream> {
    return this.execution.stdout();
  }

  stderr(): Promise<BoxOutputStream> {
    return this.execution.stderr();
  }

  wait(): Promise<{ exitCode: number; errorMessage?: string }> {
    return this.execution.wait();
  }

  kill(): Promise<void> {
    return this.execution.kill();
  }
}

function toBoxInfo(info: {
  id: string;
  name?: string | null;
  image: string;
  cpus: number;
  memoryMib: number;
  state: { running: boolean; status: string };
}): BoxInfo {
  return {
    id: info.id,
    name: info.name ?? undefined,
    image: info.image,
    cpus: info.cpus,
    memoryMib: info.memoryMib,
    running: info.state.running,
    status: info.state.status,
  };
}
