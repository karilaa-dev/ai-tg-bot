import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  listSandboxInfos: vi.fn(),
  createSandbox: vi.fn(),
  createManager: vi.fn(),
}));

vi.mock("@alibaba-group/opensandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@alibaba-group/opensandbox")>();
  return {
    ...actual,
    Sandbox: {
      create: sdkMocks.createSandbox,
    },
    SandboxManager: {
      create: sdkMocks.createManager,
    },
  };
});

import {
  createOpenSandboxClient,
  createRetryableOpenSandboxClientProvider,
  formatSandboxError,
  PUBLIC_INTERNET_NETWORK_POLICY,
  type OpenSandboxClient,
} from "../../src/opensandbox/client.js";

const clientConfig = {
  OPEN_SANDBOX_DOMAIN: "localhost:8080",
  OPEN_SANDBOX_PROTOCOL: "http",
  OPEN_SANDBOX_API_KEY: "",
  OPEN_SANDBOX_CONTROL_TIMEOUT_MS: 1_000,
  OPEN_SANDBOX_READY_TIMEOUT_MS: 300_000,
  OPEN_SANDBOX_USE_SERVER_PROXY: false,
} as unknown as Parameters<typeof createOpenSandboxClient>[0];

describe("OpenSandbox client provider", () => {
  beforeEach(() => {
    sdkMocks.listSandboxInfos.mockReset();
    sdkMocks.createSandbox.mockReset();
    sdkMocks.createManager.mockReset();
    sdkMocks.createManager.mockImplementation(() => ({
      listSandboxInfos: sdkMocks.listSandboxInfos,
    }));
  });

  it("shares only in-flight initialization and retries with a fresh client afterward", async () => {
    const firstClient = {} as OpenSandboxClient;
    const secondClient = {} as OpenSandboxClient;
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const provider = createRetryableOpenSandboxClientProvider(factory);

    await expect(provider()).rejects.toThrow("offline");
    const [first, second] = await Promise.all([provider(), provider()]);

    expect(first).toBe(firstClient);
    expect(second).toBe(firstClient);
    await expect(provider()).resolves.toBe(secondClient);
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it("formats SDK and transport failures without exposing special handling", () => {
    expect(formatSandboxError(new Error("request failed"))).toBe("Error: request failed");
  });

  it("keeps the SDK transport alive for the full sandbox readiness window", async () => {
    await createOpenSandboxClient(clientConfig);

    expect(sdkMocks.createManager).toHaveBeenCalledWith({
      connectionConfig: expect.objectContaining({ requestTimeoutSeconds: 300 }),
    });
  });

  it("passes only the provisioning environment into Sandbox.create", async () => {
    sdkMocks.createSandbox.mockResolvedValue({ id: "sandbox-created" });
    const client = await createOpenSandboxClient(clientConfig);
    await client.create({
      image: "runner:test",
      metadata: { owner: "test" },
      env: {
        OPENSANDBOX_EGRESS_DNS_UPSTREAM: "1.1.1.1:53,8.8.8.8:53",
        OPENSANDBOX_EGRESS_NAMESERVER_EXEMPT: "1.1.1.1,8.8.8.8",
      },
      mounts: [],
      cpu: "1",
      memory: "128Mi",
      readyTimeoutMs: 300_000,
      idleReleaseMs: 900_000,
    });

    expect(sdkMocks.createSandbox).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        OPENSANDBOX_EGRESS_DNS_UPSTREAM: "1.1.1.1:53,8.8.8.8:53",
        OPENSANDBOX_EGRESS_NAMESERVER_EXEMPT: "1.1.1.1,8.8.8.8",
      },
    }));
    expect(sdkMocks.createSandbox.mock.calls[0]?.[0]?.env).not.toHaveProperty("OPEN_SANDBOX_API_KEY");
  });

  it("denies non-public IPv4 and IPv6 ranges before allowing public traffic", () => {
    expect(PUBLIC_INTERNET_NETWORK_POLICY.defaultAction).toBe("allow");
    expect(PUBLIC_INTERNET_NETWORK_POLICY.egress).toEqual(expect.arrayContaining([
      { action: "deny", target: "10.0.0.0/8" },
      { action: "deny", target: "100.64.0.0/10" },
      { action: "deny", target: "127.0.0.0/8" },
      { action: "deny", target: "169.254.0.0/16" },
      { action: "deny", target: "172.16.0.0/12" },
      { action: "deny", target: "192.168.0.0/16" },
      { action: "deny", target: "224.0.0.0/4" },
      { action: "deny", target: "240.0.0.0/4" },
      { action: "deny", target: "::1/128" },
      { action: "deny", target: "fc00::/7" },
      { action: "deny", target: "fe80::/10" },
      { action: "deny", target: "fec0::/10" },
      { action: "deny", target: "ff00::/8" },
    ]));
    expect(PUBLIC_INTERNET_NETWORK_POLICY.egress?.every((rule) => rule.action === "deny")).toBe(true);
  });

  it("lists all reported sandbox pages", async () => {
    sdkMocks.listSandboxInfos
      .mockResolvedValueOnce({
        items: [sandboxInfo("sandbox-1")],
        pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 2, hasNextPage: true },
      })
      .mockResolvedValueOnce({
        items: [sandboxInfo("sandbox-2")],
        pagination: { page: 2, pageSize: 100, totalItems: 2, totalPages: 2, hasNextPage: false },
      });

    const client = await createOpenSandboxClient(clientConfig);

    await expect(client.list({ owner: "telegram" })).resolves.toEqual([
      expect.objectContaining({ id: "sandbox-1" }),
      expect.objectContaining({ id: "sandbox-2" }),
    ]);
    expect(sdkMocks.listSandboxInfos).toHaveBeenNthCalledWith(
      1,
      { metadata: { owner: "telegram" }, page: 1, pageSize: 100 },
    );
    expect(sdkMocks.listSandboxInfos).toHaveBeenNthCalledWith(
      2,
      { metadata: { owner: "telegram" }, page: 2, pageSize: 100 },
    );
  });

  it("rejects a response without required pagination metadata", async () => {
    sdkMocks.listSandboxInfos.mockResolvedValue({
      items: [sandboxInfo("sandbox-1")],
    });
    const client = await createOpenSandboxClient(clientConfig);

    await expect(client.list({ owner: "telegram" })).rejects.toThrow(
      "inconsistent sandbox pagination for requested page 1",
    );
  });

  it("rejects a repeated pagination page instead of listing forever", async () => {
    sdkMocks.listSandboxInfos.mockResolvedValue({
      items: [],
      pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 2, hasNextPage: true },
    });
    const client = await createOpenSandboxClient(clientConfig);

    await expect(client.list({ owner: "telegram" })).rejects.toThrow(
      "inconsistent sandbox pagination for requested page 2",
    );
    expect(sdkMocks.listSandboxInfos).toHaveBeenCalledTimes(2);
  });

  it("validates and rejects a repeated terminal pagination page", async () => {
    sdkMocks.listSandboxInfos
      .mockResolvedValueOnce({
        items: [sandboxInfo("sandbox-1")],
        pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 2, hasNextPage: true },
      })
      .mockResolvedValueOnce({
        items: [sandboxInfo("sandbox-1")],
        pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1, hasNextPage: false },
      });
    const client = await createOpenSandboxClient(clientConfig);

    await expect(client.list({ owner: "telegram" })).rejects.toThrow(
      "inconsistent sandbox pagination for requested page 2",
    );
    expect(sdkMocks.listSandboxInfos).toHaveBeenCalledTimes(2);
  });

  it("bounds pagination even when the server keeps extending the page count", async () => {
    sdkMocks.listSandboxInfos.mockImplementation(async ({ page }: { page: number }) => ({
      items: [],
      pagination: {
        page,
        pageSize: 100,
        totalItems: page + 1,
        totalPages: page + 1,
        hasNextPage: true,
      },
    }));
    const client = await createOpenSandboxClient(clientConfig);

    await expect(client.list({ owner: "telegram" })).rejects.toThrow(
      "sandbox listing exceeded 1000 pages",
    );
    expect(sdkMocks.listSandboxInfos).toHaveBeenCalledTimes(1_000);
  });
});

function sandboxInfo(id: string) {
  return {
    id,
    status: { state: "Running" },
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}
