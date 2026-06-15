import type { AppConfig } from "./config.js";

const levels = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof levels)[number];

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export function createLogger(config: Pick<AppConfig, "LOG_LEVEL">): Logger {
  const min = levels.indexOf(config.LOG_LEVEL);
  const write = (level: LogLevel, message: string, meta?: unknown) => {
    if (levels.indexOf(level) < min) return;
    const payload = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${payload}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };

  return {
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}
