import { isUuid } from "../utils/uuid.js";
import { WebHttpError } from "./auth.js";

export function uuid(value: string | null): string {
  if (value === null || !isUuid(value)) throw new WebHttpError(400, "Invalid UUID.");
  return value;
}
