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
