import { randomUUID } from "node:crypto";
import { Sandbox } from "e2b";
import {
  E2B_TOOLBOX_CPU_COUNT,
  E2B_TOOLBOX_MEMORY_MB,
} from "./template.js";

export async function validateE2BToolboxTemplate(
  templateRef: string,
  apiKey: string,
): Promise<{ sandboxId: string; templateRef: string }> {
  let sandbox: Sandbox | undefined;
  let sandboxId: string | undefined;
  try {
    sandbox = await Sandbox.create(templateRef, {
      apiKey,
      timeoutMs: 5 * 60_000,
      secure: true,
      allowInternetAccess: true,
      lifecycle: { onTimeout: { action: "pause", keepMemory: true }, autoResume: false },
    });
    sandboxId = sandbox.sandboxId;
    const info = await Sandbox.getInfo(sandboxId, { apiKey });
    if (info.cpuCount !== E2B_TOOLBOX_CPU_COUNT || info.memoryMB !== E2B_TOOLBOX_MEMORY_MB) {
      throw new Error(`Unexpected sandbox resources: ${info.cpuCount} vCPU / ${info.memoryMB} MiB`);
    }

    const contract = await sandbox.commands.run("/usr/local/bin/tool-contract.sh", {
      timeoutMs: 5 * 60_000,
      user: "user",
    });
    if (contract.exitCode !== 0) {
      throw new Error(contract.stderr || contract.stdout || "tool contract failed");
    }

    const network = await sandbox.commands.run("curl -fsSL https://api.github.com/zen >/dev/null", {
      timeoutMs: 30_000,
      user: "user",
    });
    if (network.exitCode !== 0) throw new Error(network.stderr || "outbound internet check failed");

    const marker = `toolbox-${randomUUID()}`;
    await sandbox.files.write("/home/user/workspace/.template-persistence-check", marker, { user: "user" });
    await sandbox.pause({ keepMemory: true });
    sandbox = await Sandbox.connect(sandboxId, { apiKey, timeoutMs: 5 * 60_000 });
    const restored = await sandbox.files.read("/home/user/workspace/.template-persistence-check", { format: "text" });
    if (restored !== marker) throw new Error("pause/resume persistence check failed");

    return { sandboxId, templateRef };
  } finally {
    if (sandboxId) await Sandbox.kill(sandboxId, { apiKey }).catch(() => undefined);
  }
}

export function requireE2BApiKey(): string {
  const apiKey = process.env.E2B_API_KEY?.trim();
  if (!apiKey) throw new Error("E2B_API_KEY is required");
  return apiKey;
}
