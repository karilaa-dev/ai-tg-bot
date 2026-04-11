import type { AppConfig } from '../config.js';
import type { DatabaseRepository } from '../domain.js';
import { PostgresRepository } from './postgres.js';
import { SQLiteRepository } from './sqlite.js';

export function createRepository(config: AppConfig): DatabaseRepository {
  if (config.databaseClient === 'pg') {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is required when DATABASE_CLIENT=pg');
    }

    return new PostgresRepository({
      connectionString: config.databaseUrl,
    });
  }

  return new SQLiteRepository(config.sqliteFilename);
}
