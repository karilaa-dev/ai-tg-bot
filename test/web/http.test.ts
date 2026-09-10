import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("serves the website in Node.js with the existing SQLite adapter", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "test/web/http-smoke.ts"], { timeout: 30_000 });
  expect(stdout).toContain("Node.js HTTP smoke passed");
}, 35_000);

it.skipIf(!process.env.TEST_POSTGRES_URL)("serves the website in Node.js with PostgreSQL", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "test/web/http-smoke.ts", "--postgres"], { timeout: 30_000 });
  expect(stdout).toContain("Node.js HTTP smoke passed");
}, 35_000);
