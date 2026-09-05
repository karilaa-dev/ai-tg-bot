import { asRecord } from "../util/records.js";

export function toolResultFailed(value: unknown): boolean {
  const result = asRecord(value);
  if (!result) return false;
  return (typeof result.error === "string" && result.error.trim().length > 0)
    || result.timed_out === true
    || ("exit_code" in result && result.exit_code !== 0)
    || result.status === "failed"
    || result.status === "error";
}
