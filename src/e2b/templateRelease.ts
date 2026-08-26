import { SandboxError, Template, defaultBuildLogger, type BuildInfo } from "e2b";
import { buildE2BToolboxTemplate } from "../../e2b-template/builder.js";
import { validateE2BToolboxTemplate } from "../../e2b-template/validate.js";
import type { Logger } from "../logger.js";
import {
  E2B_TOOLBOX_TEMPLATE_NAME,
  parseManagedE2BTemplateRef,
} from "./templateIdentity.js";

export interface E2BTemplateReleaseResult {
  templateRef: string;
  status: "built" | "reused";
  templateId?: string;
  buildId?: string;
}

export interface E2BTemplateReleaseDependencies {
  exists(templateRef: string, apiKey: string): Promise<boolean>;
  build(templateRef: string, apiKey: string): Promise<BuildInfo>;
  validate(templateRef: string, apiKey: string): Promise<void>;
}

export class E2BTemplateReleaseManager {
  private readonly active = new Map<string, Promise<E2BTemplateReleaseResult>>();
  private readonly dependencies: E2BTemplateReleaseDependencies;

  constructor(
    private readonly apiKey: string,
    private readonly logger?: Logger,
    dependencies: Partial<E2BTemplateReleaseDependencies> = {},
  ) {
    this.dependencies = {
      exists: dependencies.exists ?? ((templateRef, key) => Template.exists(templateRef, { apiKey: key })),
      build: dependencies.build ?? ((templateRef, key) =>
        buildE2BToolboxTemplate(templateRef, key, defaultBuildLogger())),
      validate: dependencies.validate ?? (async (templateRef, key) => {
        await validateE2BToolboxTemplate(templateRef, key);
      }),
    };
  }

  async recoverMissingTemplate(templateRef: string, error: unknown): Promise<boolean> {
    if (!isE2BNotFoundError(error) || !parseManagedE2BTemplateRef(templateRef)) return false;
    await this.ensure(templateRef);
    return true;
  }

  ensure(templateRef: string): Promise<E2BTemplateReleaseResult> {
    if (!parseManagedE2BTemplateRef(templateRef)) {
      return Promise.reject(new Error(
        `Automatic E2B releases require ${E2B_TOOLBOX_TEMPLATE_NAME}:<tag>; received ${templateRef}`,
      ));
    }
    const running = this.active.get(templateRef);
    if (running) return running;

    const release = this.ensureUnshared(templateRef).finally(() => {
      if (this.active.get(templateRef) === release) this.active.delete(templateRef);
    });
    this.active.set(templateRef, release);
    return release;
  }

  private async ensureUnshared(templateRef: string): Promise<E2BTemplateReleaseResult> {
    if (await this.dependencies.exists(templateRef, this.apiKey)) {
      this.logger?.info("reusing existing E2B template", { templateRef });
      await this.dependencies.validate(templateRef, this.apiKey);
      return { templateRef, status: "reused" };
    }

    this.logger?.warn("E2B template is missing; building it before retry", { templateRef });
    let buildInfo: BuildInfo;
    try {
      buildInfo = await this.dependencies.build(templateRef, this.apiKey);
    } catch (error) {
      if (!await this.dependencies.exists(templateRef, this.apiKey)) throw error;
      this.logger?.info("another process created the E2B template", { templateRef });
      await this.dependencies.validate(templateRef, this.apiKey);
      return { templateRef, status: "reused" };
    }

    await this.dependencies.validate(templateRef, this.apiKey);
    this.logger?.info("E2B template built and validated", {
      templateRef,
      templateId: buildInfo.templateId,
      buildId: buildInfo.buildId,
    });
    return {
      templateRef,
      status: "built",
      templateId: buildInfo.templateId,
      buildId: buildInfo.buildId,
    };
  }
}

export async function createWithMissingTemplateRecovery<T>(
  create: () => Promise<T>,
  recover: (error: unknown) => Promise<boolean>,
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (!await recover(error)) throw error;
    return create();
  }
}

export function isE2BNotFoundError(error: unknown): boolean {
  return error instanceof SandboxError && /^404(?:\s|:)/u.test(error.message);
}
