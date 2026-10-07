import type { SqlExecutor } from "../db/sql.js";
import { DatabaseMemoryStore } from "./optmem/databaseStore.js";

export async function initializeUserMemory(db: SqlExecutor, userId: number): Promise<void> {
  const store = new DatabaseMemoryStore(db, userId);
  if (!await store.exists()) await store.initialize();
}
