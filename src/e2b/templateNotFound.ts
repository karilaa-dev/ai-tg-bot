import { SandboxError, Template } from "e2b";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { parseManagedE2BTemplateRef } from "./templateIdentity.js";

export class E2BTemplateNotFoundError extends Error {
  constructor(
    readonly templateRef: string,
    cause: unknown,
  ) {
    super(
      `E2B sandbox image "${templateRef}" was not found. `
      + "Build the current version with \"bun run e2b:release\" before creating a new thread, "
      + "or set E2B_TEMPLATE to an existing image.",
      { cause },
    );
    this.name = "E2BTemplateNotFoundError";
  }
}

export async function checkManagedE2BTemplate(
  config: Pick<AppConfig, "E2B_TEMPLATE" | "E2B_API_KEY" | "E2B_REQUEST_TIMEOUT_MS">,
  logger: Logger,
  templateExists: typeof Template.exists = (name, options) => Template.exists(name, options),
): Promise<void> {
  if (!parseManagedE2BTemplateRef(config.E2B_TEMPLATE)) return;
  let exists: boolean;
  try {
    exists = await templateExists(config.E2B_TEMPLATE, {
      apiKey: config.E2B_API_KEY,
      requestTimeoutMs: config.E2B_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    logger.warn("E2B template availability check failed; sandbox creation will retry", {
      templateRef: config.E2B_TEMPLATE, err: String(error),
    });
    return;
  }
  if (!exists) throw new E2BTemplateNotFoundError(config.E2B_TEMPLATE, undefined);
  logger.info("E2B template available", { templateRef: config.E2B_TEMPLATE });
}

export async function createWithTemplateNotFoundError<T>(
  templateRef: string,
  create: () => Promise<T>,
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (isE2BNotFoundError(error)) {
      throw new E2BTemplateNotFoundError(templateRef, error);
    }
    throw error;
  }
}

export function isE2BNotFoundError(error: unknown): boolean {
  return error instanceof SandboxError && /^404(?:\s|:)/u.test(error.message);
}
