import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("serves the website in Bun with the existing SQLite adapter", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["test/web/http-smoke.ts"], { timeout: 30_000 });
  expect(stdout).toContain("Bun HTTP smoke passed");
}, 35_000);

it.skipIf(!process.env.TEST_POSTGRES_URL)("serves the website in Bun with PostgreSQL", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["test/web/http-smoke.ts", "--postgres"], { timeout: 30_000 });
  expect(stdout).toContain("Bun HTTP smoke passed");
}, 35_000);
