import type { AppConfig } from "./config.js";

const levels = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof levels)[number];

export interface Logger {
  level: LogLevel;
  isLevelEnabled(level: LogLevel): boolean;
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export function createLogger(config: Pick<AppConfig, "LOG_LEVEL">): Logger {
  const min = levels.indexOf(config.LOG_LEVEL);
  const isLevelEnabled = (level: LogLevel) => levels.indexOf(level) >= min;
  const write = (level: LogLevel, message: string, meta?: unknown) => {
    if (!isLevelEnabled(level)) return;
    const payload = meta === undefined ? "" : ` ${stringifyMeta(meta)}`;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${payload}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };

  return {
    level: config.LOG_LEVEL,
    isLevelEnabled,
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}

function stringifyMeta(meta: unknown): string {
  try {
    return JSON.stringify(meta, (_key, value) => typeof value === "bigint" ? value.toString() : value);
  } catch {
    return JSON.stringify({ meta: String(meta) });
  }
}
