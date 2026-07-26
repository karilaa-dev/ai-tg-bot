import type {
  SandboxCommandLifecycle,
  SandboxCommandPreparation,
  SandboxCommandRequest,
} from "./types.js";

type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export async function runSandboxCommandLifecycle<T>(
  lifecycle: SandboxCommandLifecycle | undefined,
  operation: (preparation: SandboxCommandPreparation | undefined) => Promise<T>,
): Promise<T> {
  const operationOutcome = await settle(async () => {
    const preparation = await lifecycle?.beforeExecute?.();
    return operation(preparation || undefined);
  });
  const cleanupOutcome = await settle(async () => lifecycle?.afterExecute?.());

  if (!operationOutcome.ok && !cleanupOutcome.ok) {
    throw new AggregateError(
      [operationOutcome.error, cleanupOutcome.error],
      "OpenSandbox command and lifecycle cleanup both failed",
    );
  }
  if (!operationOutcome.ok) throw operationOutcome.error;
  if (!cleanupOutcome.ok) throw cleanupOutcome.error;
  return operationOutcome.value;
}

export function applySandboxCommandPreparation(
  request: SandboxCommandRequest,
  preparation: SandboxCommandPreparation | undefined,
): SandboxCommandRequest {
  if (!preparation) return request;
  return {
    ...request,
    ...preparation,
    env: { ...request.env, ...preparation.env },
  };
}

async function settle<T>(operation: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
}
