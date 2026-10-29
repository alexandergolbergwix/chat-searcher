"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordError = recordError;
exports.errorMessage = errorMessage;
exports.readDatabase = readDatabase;
exports.resetSqliteCliSupport = resetSqliteCliSupport;
exports.runSqliteCli = runSqliteCli;
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
/** fs.readFileSync cannot read a file of 2 GiB or more. */
const MAX_READ_BYTES = 2 * 1024 * 1024 * 1024 - 1;
function recordError(stats, message) {
    if (stats && stats.errors.length < 5)
        stats.errors.push(message);
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
/** Loads a SQLite file into sql.js. Throws a clear error for files that Node cannot read in one call. */
function readDatabase(SQL, dbPath) {
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
const CLI_OPTION_SETS = [
    ['-readonly', '-json'],
    ['-json'],
];
const PROBE_SQL = `SELECT json_extract('{"ok":1}', '$.ok') AS ok`;
const MIN_JSON_VERSION = [3, 33, 0];
/** Database path -> sqlite3 options that work for it, or why the CLI cannot be used. */
const cliSupport = new Map();
/** Forgets the probe results, so that the next query tests the CLI again (for example after sqlite3 is installed). */
function resetSqliteCliSupport() {
    cliSupport.clear();
}
function execSqlite(args, maxBuffer) {
    return (0, child_process_1.execFileSync)('sqlite3', args, {
        maxBuffer,
        encoding: 'utf-8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
}
/** The first line that sqlite3 wrote to stderr, or the Node error message. */
function cliErrorText(err) {
    const stderr = err.stderr;
    const text = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf-8') : '';
    const firstLine = text.split(/\r?\n/).find((l) => l.trim());
    return firstLine ? firstLine.trim() : errorMessage(err);
}
function isMissingBinary(err) {
    return err.code === 'ENOENT';
}
function sqliteVersion() {
    try {
        return /^(\d+\.\d+\.\d+)/.exec(execSqlite(['-version'], 1024 * 1024).trim())?.[1];
    }
    catch {
        return undefined;
    }
}
function isOlderThan(version, min) {
    const parts = version.split('.').map(Number);
    for (let i = 0; i < min.length; i++) {
        const v = parts[i] ?? 0;
        if (v !== min[i])
            return v < min[i];
    }
    return false;
}
function detectCliSupport(dbPath) {
    let lastError = '';
    for (const options of CLI_OPTION_SETS) {
        try {
            const out = execSqlite([...options, dbPath, PROBE_SQL], 1024 * 1024);
            const rows = JSON.parse(out);
            if (Array.isArray(rows) && rows[0]?.ok === 1)
                return { options };
            lastError = `unexpected output: ${out.trim().slice(0, 80)}`;
        }
        catch (err) {
            if (isMissingBinary(err))
                return { error: 'sqlite3 was not found on PATH' };
            lastError = err instanceof SyntaxError ? 'output is not JSON' : cliErrorText(err);
        }
    }
    const version = sqliteVersion();
    if (version && isOlderThan(version, MIN_JSON_VERSION)) {
        return { error: `sqlite3 ${version} is too old. JSON output needs sqlite3 ${MIN_JSON_VERSION.join('.')} or later` };
    }
    return { error: `sqlite3${version ? ' ' + version : ''} cannot query ${dbPath}: ${lastError}` };
}
/**
 * Runs a query with the system sqlite3 CLI and returns its JSON output.
 * Uses -readonly when this sqlite3 supports it for the database. Throws an
 * error that says why when the CLI cannot be used.
 */
function runSqliteCli(dbPath, sql, maxBuffer) {
    let support = cliSupport.get(dbPath);
    if (!support) {
        support = detectCliSupport(dbPath);
        cliSupport.set(dbPath, support);
    }
    if ('error' in support)
        throw new Error(support.error);
    try {
        return execSqlite([...support.options, dbPath, sql], maxBuffer);
    }
    catch (err) {
        throw new Error(`sqlite3 query failed: ${cliErrorText(err)}`);
    }
}
//# sourceMappingURL=dbUtil.js.map