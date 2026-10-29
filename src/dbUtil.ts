import * as fs from 'fs';
import {execFileSync} from 'child_process';
import {Database, SqlJsStatic} from 'sql.js';

/** fs.readFileSync cannot read a file of 2 GiB or more. */
const MAX_READ_BYTES = 2 * 1024 * 1024 * 1024 - 1;

/** Problems found while indexing, so that an empty index can say why. */
export interface IndexStats {
  failed: number;
  errors: string[];
}

export function recordError(stats: IndexStats | undefined, message: string): void {
  if (stats && stats.errors.length < 5) stats.errors.push(message);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Loads a SQLite file into sql.js. Throws a clear error for files that Node cannot read in one call. */
export function readDatabase(SQL: SqlJsStatic, dbPath: string): Database {
  const size = fs.statSync(dbPath).size;
  if (size > MAX_READ_BYTES) {
    throw new Error(`${dbPath} is ${(size / 1024 ** 3).toFixed(1)} GB, which is too large to load into memory`);
  }
  return new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
}

/*
 * sqlite3 CLI support.
 *
 * The queries need JSON output (-json, added in sqlite3 3.33.0) and the JSON
 * SQL functions. -readonly is preferred so the CLI cannot write to the IDE's
 * database. The SQLite release notes do not say which version added
 * -readonly, and a read-only open can also fail for other reasons. So the
 * options are tested against the database once, instead of being assumed.
 */
const CLI_OPTION_SETS: string[][] = [
  ['-readonly', '-json'],
  ['-json'],
];
const PROBE_SQL = `SELECT json_extract('{"ok":1}', '$.ok') AS ok`;
const MIN_JSON_VERSION = [3, 33, 0];

type CliSupport = {options: string[]} | {error: string};

/** Database path -> sqlite3 options that work for it, or why the CLI cannot be used. */
const cliSupport = new Map<string, CliSupport>();

/** Forgets the probe results, so that the next query tests the CLI again (for example after sqlite3 is installed). */
export function resetSqliteCliSupport(): void {
  cliSupport.clear();
}

function execSqlite(args: string[], maxBuffer: number): string {
  return execFileSync('sqlite3', args, {
    maxBuffer,
    encoding: 'utf-8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

/** The first line that sqlite3 wrote to stderr, or the Node error message. */
function cliErrorText(err: unknown): string {
  const stderr = (err as {stderr?: unknown}).stderr;
  const text = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf-8') : '';
  const firstLine = text.split(/\r?\n/).find((l) => l.trim());
  return firstLine ? firstLine.trim() : errorMessage(err);
}

function isMissingBinary(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function sqliteVersion(): string | undefined {
  try {
    return /^(\d+\.\d+\.\d+)/.exec(execSqlite(['-version'], 1024 * 1024).trim())?.[1];
  } catch {
    return undefined;
  }
}

function isOlderThan(version: string, min: number[]): boolean {
  const parts = version.split('.').map(Number);
  for (let i = 0; i < min.length; i++) {
    const v = parts[i] ?? 0;
    if (v !== min[i]) return v < min[i];
  }
  return false;
}

function detectCliSupport(dbPath: string): CliSupport {
  let lastError = '';
  for (const options of CLI_OPTION_SETS) {
    try {
      const out = execSqlite([...options, dbPath, PROBE_SQL], 1024 * 1024);
      const rows = JSON.parse(out) as Array<{ok?: unknown}>;
      if (Array.isArray(rows) && rows[0]?.ok === 1) return {options};
      lastError = `unexpected output: ${out.trim().slice(0, 80)}`;
    } catch (err) {
      if (isMissingBinary(err)) return {error: 'sqlite3 was not found on PATH'};
      lastError = err instanceof SyntaxError ? 'output is not JSON' : cliErrorText(err);
    }
  }
  const version = sqliteVersion();
  if (version && isOlderThan(version, MIN_JSON_VERSION)) {
    return {error: `sqlite3 ${version} is too old. JSON output needs sqlite3 ${MIN_JSON_VERSION.join('.')} or later`};
  }
  return {error: `sqlite3${version ? ' ' + version : ''} cannot query ${dbPath}: ${lastError}`};
}

/**
 * Runs a query with the system sqlite3 CLI and returns its JSON output.
 * Uses -readonly when this sqlite3 supports it for the database. Throws an
 * error that says why when the CLI cannot be used.
 */
export function runSqliteCli(dbPath: string, sql: string, maxBuffer: number): string {
  let support = cliSupport.get(dbPath);
  if (!support) {
    support = detectCliSupport(dbPath);
    cliSupport.set(dbPath, support);
  }
  if ('error' in support) throw new Error(support.error);
  try {
    return execSqlite([...support.options, dbPath, sql], maxBuffer);
  } catch (err) {
    throw new Error(`sqlite3 query failed: ${cliErrorText(err)}`);
  }
}
