import { SandboxError } from "e2b";

export class E2BTemplateNotFoundError extends Error {
  constructor(
    readonly templateRef: string,
    cause: unknown,
  ) {
    super(
      `E2B sandbox image "${templateRef}" was not found. `
      + "Build the current version with \"npm run e2b:release\" before creating a new thread, "
      + "or set E2B_TEMPLATE to an existing image.",
      { cause },
    );
    this.name = "E2BTemplateNotFoundError";
  }
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
