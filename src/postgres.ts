import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Read-only SQL on local DualPMS Postgres (peer auth via sudo). */
export async function execLocalPsql(sql: string, database?: string): Promise<string> {
  const db = database?.trim() || process.env.PGDATABASE?.trim() || "hotel";
  const remoteCmd = `sudo -u postgres psql -d ${shellQuote(db)} -t -A -c ${shellQuote(sql)}`;
  const { stdout, stderr } = await execFileAsync("bash", ["-lc", remoteCmd], {
    maxBuffer: 10 * 1024 * 1024,
  });
  if (stderr?.trim() && !stdout?.trim()) {
    throw new Error(stderr.trim());
  }
  return stdout.trim();
}

export async function queryLocalJson<T>(sql: string, fallback: T, database?: string): Promise<T> {
  const raw = await execLocalPsql(sql, database);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Failed to parse Postgres JSON: ${raw.slice(0, 200)}`);
  }
}

export async function testLocalPostgres(): Promise<void> {
  await execLocalPsql("SELECT 1");
}
