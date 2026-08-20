import { describe, expect, it } from "vitest";
import { createPostgresService } from "../../src/upgrade/exportConnection.js";

describe("Unraid export PostgreSQL service file", () => {
  it("converts a PostgreSQL URL without exposing it as a command argument", () => {
    expect(createPostgresService(
      "postgresql://aibot:secret%20value@postgres:5433/aibot?sslmode=require",
    )).toBe([
      "[upgrade]",
      "host='postgres'",
      "port='5433'",
      "user='aibot'",
      "dbname='aibot'",
      "password='secret value'",
      "sslmode='require'",
      "",
    ].join("\n"));
  });

  it("escapes libpq service values", () => {
    expect(createPostgresService(
      "postgresql://aibot:p%27ass%5Cword@postgres/aibot",
    )).toContain("password='p\\'ass\\\\word'");
  });

  it.each([
    "sqlite:/app/data/bot.db",
    "not a URL",
    "postgresql://postgres",
  ])("rejects an unusable source URL: %s", (dbUrl) => {
    expect(() => createPostgresService(dbUrl)).toThrow();
  });

  it("rejects query parameters that override connection identity", () => {
    expect(() => createPostgresService(
      "postgresql://aibot:secret@postgres/aibot?host=elsewhere",
    )).toThrow("must not override");
  });
});
