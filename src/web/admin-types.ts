export type { AllowedUser } from "../access/control.js";

export type AdminSession =
  | { authenticated: false; loginAvailable: boolean }
  | { authenticated: true; userId: number; admin: boolean };

export interface CodexStatus {
  credentialStatus: "available" | "missing" | "invalid";
  login: {
    status: "idle" | "starting" | "pending" | "success" | "error" | "cancelled" | "expired";
    userCode?: string;
    verificationUri?: string;
    expiresAt?: number;
    error?: string;
  };
}
