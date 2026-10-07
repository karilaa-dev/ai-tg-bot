#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createDatabase } from "../../db/index.js";
import { UsersRepo } from "../../db/repos/users.js";
import { initializeUserMemory } from "../userMemory.js";
import { runMemo } from "./index.js";
import { DatabaseMemoryStore } from "./databaseStore.js";
import { MemoryEnvironmentSchema, memorySizes } from "./settings.js";
import { recallInWorker } from "./recall.js";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const [option, requestedUser, ...args] = process.argv.slice(2);
const userId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).safeParse(requestedUser);
if (option !== "--user" || !userId.success || !args.length) {
  process.stderr.write("Usage: memo --user <Telegram user ID> <command> [args...]\n");
  process.exitCode = 1;
} else {
  const config = MemoryEnvironmentSchema.extend({
    DB_URL: z.string().default("sqlite:./data/bot.db"),
  }).parse(process.env);
  const db = createDatabase(config);
  try {
    await db.initialize();
    const user = await new UsersRepo(db.db).get(userId.data);
    if (!user) throw new Error("Unknown Telegram user. Start the bot as this user before using memo.");
    if (user.memory_enabled) await initializeUserMemory(db.db, userId.data);
    const input = {
      store: new DatabaseMemoryStore(db.db, userId.data), settings: memorySizes(config),
      utcOffsetMinutes: user.tz_offset_min ?? 0,
      command: `${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} --user ${userId.data}`,
    };
    const result = args[0] === "recall" && args.length === 2
      ? await recallInWorker(input, args[1]) : await runMemo({ ...input, args });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exit_code;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally { await db.destroy(); }
}
