export type { AllowedUser } from "../access/control.js";

export type AdminSession =
  | { authenticated: false; loginAvailable: boolean }
  | { authenticated: true; userId: number; admin: boolean };

export interface CodexStatus {
  credentialStatus: "available" | "missing" | "invalid";
  login:
    | { status: "idle" | "success" | "cancelled" }
    | { status: "starting" }
    | { status: "pending"; userCode: string; verificationUri: string; expiresAt: number }
    | { status: "error" | "expired"; error: string };
}
