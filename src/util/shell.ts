export function shellJoin(tokens: string[]): string {
  return tokens.map(quoteShellToken).join(" ");
}

export function quoteShellToken(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
