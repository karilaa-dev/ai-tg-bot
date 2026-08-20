export function createPostgresService(dbUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(dbUrl);
  } catch {
    throw new Error("DB_URL must be a valid PostgreSQL URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DB_URL must use PostgreSQL, not SQLite or another database.");
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  const username = decodeURIComponent(parsed.username);
  if (!parsed.hostname || !username || !database) {
    throw new Error("DB_URL must include a PostgreSQL host, user, and database name.");
  }

  const parameters = new Map<string, string>([
    ["host", parsed.hostname],
    ["port", parsed.port || "5432"],
    ["user", username],
    ["dbname", database],
  ]);
  if (parsed.password) parameters.set("password", decodeURIComponent(parsed.password));

  for (const [key, value] of parsed.searchParams) {
    if (!/^[a-z][a-z0-9_]*$/u.test(key)) {
      throw new Error(`DB_URL contains an invalid PostgreSQL parameter: ${key}`);
    }
    if (parameters.has(key)) {
      throw new Error(`DB_URL must not override the PostgreSQL ${key} parameter in its query string.`);
    }
    parameters.set(key, value);
  }

  return [
    "[upgrade]",
    ...Array.from(parameters, ([key, value]) => `${key}=${quoteServiceValue(value)}`),
    "",
  ].join("\n");
}

function quoteServiceValue(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
