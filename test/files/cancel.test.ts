import { expect, it } from "vitest";
import { raceWithAbort } from "../../src/files/cancel.js";
import { deferred } from "../helpers/async.js";

it.each([true, false])("observes late operation failures when cancellation precedes waiting: %s", async (alreadyAborted) => {
  const controller = new AbortController();
  const operation = deferred<void>();
  const reason = new Error("cancelled by user");
  if (alreadyAborted) controller.abort(reason);
  const result = raceWithAbort(operation.promise, controller.signal);
  controller.abort(reason);
  await expect(result).rejects.toBe(reason);
  operation.reject(new Error("request failed after cancellation"));
  // Let unhandled rejections surface to the runner if the operation was orphaned.
  await new Promise((resolve) => setImmediate(resolve));
});
