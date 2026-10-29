import * as path from 'path';
import * as fs from 'fs';
import initSqlJs, {Database, SqlJsStatic} from 'sql.js';
import {errorMessage, IndexStats, readDatabase, recordError, resetSqliteCliSupport, runSqliteCli} from './dbUtil';
import {fileUriToPath, getGlobalStateDbPath, getGlobalStorageDir, getUserDataDir, getWorkspaceStorageDir, isCursorHost, pathBasename} from './storagePaths';
import {extractVsCodeDocuments, getVsCodeMessages, isVsCodeDocumentId} from './vscodeChatReader';

export interface ChatMessage {
  role: string;
  content: string;
  timestamp?: number;
}

export interface IndexDocument {
  id: string;
  text: string;
  workspaceHash: string;
  tabIndex: number;
  workspacePath: string;
  workspaceName: string;
  title: string;
  messageCount: number;
  timestamp?: number;
}

function getWorkspacePath(workspaceDir: string): string {
  try {
    const workspaceJsonPath = path.join(workspaceDir, 'workspace.json');
    if (fs.existsSync(workspaceJsonPath)) {
      const data = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf-8'));
      if (typeof data.folder === 'string' && data.folder) {
        return fileUriToPath(data.folder);
      }
      if (typeof data.workspace === 'string' && data.workspace) {
        return fileUriToPath(data.workspace);
      }
    }
  } catch {
    // ignore
  }
  return workspaceDir;
}

function getWorkspaceName(workspaceDir: string): string {
  const p = getWorkspacePath(workspaceDir);
  return pathBasename(p).replace(/\.code-workspace$/i, '') || p;
}

function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

interface ComposerMeta {
  composerId: string;
  name: string;
  createdAt?: number;
  lastUpdatedAt?: number;
}

function getComposerIdsFromDb(db: Database): ComposerMeta[] {
  try {
    const res = db.exec("SELECT value FROM ItemTable WHERE key = 'composer.composerData'");
    if (res.length === 0 || res[0].values.length === 0) return [];
    const val = res[0].values[0][0];
    if (typeof val !== 'string') return [];
    const parsed = JSON.parse(val) as Record<string, unknown>;
    const composers = parsed.allComposers;
    if (!Array.isArray(composers)) return [];
    return composers.map((c: unknown) => {
      const comp = c as Record<string, unknown>;
      return {
        composerId: String(comp.composerId || ''),
        name: String(comp.name || ''),
        createdAt: typeof comp.createdAt === 'number' ? comp.createdAt : undefined,
        lastUpdatedAt: typeof comp.lastUpdatedAt === 'number' ? comp.lastUpdatedAt : undefined,
      };
    }).filter(c => c.composerId);
  } catch {
    return [];
  }
}

interface RawBubble {
  type: number;
  text: string;
  createdAt?: number;
  order: number;
}

function rawBubblesToMessages(bubbles: RawBubble[]): ChatMessage[] {
  if (bubbles.length === 0) return [];
  if (bubbles[0].createdAt != null) {
    bubbles.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }
  return bubbles.map(b => ({
    role: b.type === 1 ? 'user' : 'assistant',
    content: b.text,
    timestamp: b.createdAt,
  }));
}

function loadAllBubblesFromGlobalCli(globalDbPath: string, stats?: IndexStats): Map<string, ChatMessage[]> | null {
  try {
    const sql = [
      "SELECT key,",
      "json_extract(value, '$.type') as type,",
      "COALESCE(json_extract(value, '$.text'), json_extract(value, '$.rawText'), json_extract(value, '$.content')) as text,",
      "json_extract(value, '$.createdAt') as createdAt",
      "FROM cursorDiskKV",
      "WHERE key LIKE 'bubbleId:%'",
      "AND json_extract(value, '$.type') IN (1, 2)",
    ].join(' ');

    const output = runSqliteCli(globalDbPath, sql, 200 * 1024 * 1024);

    const rows = JSON.parse(output || '[]') as Array<{key: string; type: number; text: string; createdAt: number | null}>;
    const composerBubbles = new Map<string, RawBubble[]>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.text || !row.text.trim()) continue;
      const firstColon = row.key.indexOf(':');
      const secondColon = row.key.indexOf(':', firstColon + 1);
      if (firstColon < 0 || secondColon < 0) continue;
      const composerId = row.key.substring(firstColon + 1, secondColon);

      let arr = composerBubbles.get(composerId);
      if (!arr) {
        arr = [];
        composerBubbles.set(composerId, arr);
      }
      arr.push({
        type: row.type,
        text: row.text.trim(),
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : undefined,
        order: i,
      });
    }

    const result = new Map<string, ChatMessage[]>();
    for (const [composerId, bubbles] of composerBubbles) {
      result.set(composerId, rawBubblesToMessages(bubbles));
    }
    return result;
  } catch (err) {
    recordError(stats, errorMessage(err));
    return null;
  }
}

function getBubblesForComposerCli(globalDbPath: string, composerId: string): ChatMessage[] {
  try {
    const escaped = escapeSqlString(composerId);
    const sql = [
      "SELECT",
      "json_extract(value, '$.type') as type,",
      "COALESCE(json_extract(value, '$.text'), json_extract(value, '$.rawText'), json_extract(value, '$.content')) as text,",
      "json_extract(value, '$.createdAt') as createdAt",
      "FROM cursorDiskKV",
      `WHERE key LIKE 'bubbleId:${escaped}:%'`,
      "AND json_extract(value, '$.type') IN (1, 2)",
    ].join(' ');

    const output = runSqliteCli(globalDbPath, sql, 50 * 1024 * 1024);

    const rows = JSON.parse(output || '[]') as Array<{type: number; text: string; createdAt: number | null}>;
    const bubbles: RawBubble[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.text || !row.text.trim()) continue;
      bubbles.push({
        type: row.type,
        text: row.text.trim(),
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : undefined,
        order: i,
      });
    }
    return rawBubblesToMessages(bubbles);
  } catch {
    return [];
  }
}

function getBubblesForComposerFromDb(globalDb: Database, composerId: string): ChatMessage[] {
  try {
    const prefix = `bubbleId:${escapeSqlString(composerId)}:`;
    const res = globalDb.exec(
      `SELECT value FROM cursorDiskKV WHERE key LIKE '${prefix}%'`
    );
    if (res.length === 0 || res[0].values.length === 0) return [];

    const bubbles: RawBubble[] = [];
    for (let i = 0; i < res[0].values.length; i++) {
      const val = res[0].values[i][0];
      if (typeof val !== 'string') continue;
      try {
        const b = JSON.parse(val) as Record<string, unknown>;
        const bType = b.type as number | undefined;
        if (bType !== 1 && bType !== 2) continue;
        const text = String(b.text ?? b.rawText ?? b.content ?? '').trim();
        if (!text) continue;
        bubbles.push({
          type: bType,
          text,
          createdAt: typeof b.createdAt === 'number' ? b.createdAt : undefined,
          order: i,
        });
      } catch {
        // skip
      }
    }
    return rawBubblesToMessages(bubbles);
  } catch {
    return [];
  }
}

function summarizeIndex(count: number, stats: IndexStats): string {
  let summary = `Indexed ${count} conversation(s) from ${getUserDataDir()}.`;
  if (stats.failed > 0) summary += ` ${stats.failed} file(s) could not be read.`;
  if (stats.errors.length > 0) summary += ` First problem: ${stats.errors[0]}`;
  return summary;
}

export interface ExtractDocumentsOptions {
  maxWorkspaces?: number;
}

function loadSqlJs(extensionPath: string): Promise<SqlJsStatic> {
  const wasmBinary = fs.readFileSync(
    path.join(extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  );
  return initSqlJs({wasmBinary: wasmBinary.buffer as ArrayBuffer});
}

function describeWorkspace(workspaceDir: string): {workspacePath: string; workspaceName: string} {
  return {workspacePath: getWorkspacePath(workspaceDir), workspaceName: getWorkspaceName(workspaceDir)};
}

export async function extractDocumentsForSearch(
  extensionPath: string,
  progressCallback?: (message: string) => void,
  options?: ExtractDocumentsOptions
): Promise<IndexDocument[]> {
  const report = (msg: string) => progressCallback?.(msg);
  const stats: IndexStats = {failed: 0, errors: []};
  const storagePath = getWorkspaceStorageDir();
  if (!fs.existsSync(storagePath)) {
    report(`No chat storage found: ${storagePath} does not exist.`);
    return [];
  }

  const SQL = await loadSqlJs(extensionPath);
  let docs: IndexDocument[] = [];
  // Cursor keeps chats in its own tables. VS Code keeps one file per chat session.
  if (isCursorHost()) {
    docs = docs.concat(extractCursorDocuments(SQL, storagePath, report, stats, options));
  }
  let vscodeDocs = extractVsCodeDocuments(SQL, storagePath, getGlobalStorageDir(), describeWorkspace, report, stats);
  if (typeof options?.maxWorkspaces === 'number') {
    const keep = new Set([...new Set(vscodeDocs.map((d) => d.workspaceHash))].slice(0, options.maxWorkspaces));
    vscodeDocs = vscodeDocs.filter((d) => keep.has(d.workspaceHash));
  }
  docs = docs.concat(vscodeDocs);

  report(summarizeIndex(docs.length, stats));
  return docs;
}

function extractCursorDocuments(
  SQL: SqlJsStatic,
  storagePath: string,
  report: (message: string) => void,
  stats: IndexStats,
  options?: ExtractDocumentsOptions
): IndexDocument[] {
  const docs: IndexDocument[] = [];
  const globalDbPath = getGlobalStateDbPath();
  const globalDbExists = fs.existsSync(globalDbPath);

  report('Loading Cursor conversation data...');
  resetSqliteCliSupport();

  let allBubbles: Map<string, ChatMessage[]> | null = null;
  let globalDb: Database | null = null;

  if (globalDbExists) {
    allBubbles = loadAllBubblesFromGlobalCli(globalDbPath, stats);
    if (!allBubbles) {
      try {
        globalDb = readDatabase(SQL, globalDbPath);
      } catch (err) {
        recordError(stats, `Cannot load ${globalDbPath}: ${errorMessage(err)}`);
      }
    }
  }

  if (allBubbles) {
    report(`Loaded ${allBubbles.size} conversation(s) from global storage.`);
  }

  const maxWorkspaces = options?.maxWorkspaces;
  const entries = fs.readdirSync(storagePath, {withFileTypes: true});
  const allDbDirs = entries.filter((e) => e.isDirectory()).map((e) => ({
    hash: e.name,
    workspaceDir: path.join(storagePath, e.name),
    dbPath: path.join(storagePath, e.name, 'state.vscdb'),
  })).filter((d) => fs.existsSync(d.dbPath));
  const dbDirs = typeof maxWorkspaces === 'number' ? allDbDirs.slice(0, maxWorkspaces) : allDbDirs;

  report(`Scanning ${dbDirs.length} Cursor workspace(s)...`);

  for (let i = 0; i < dbDirs.length; i++) {
    const {hash, workspaceDir, dbPath} = dbDirs[i];
    if (i % 50 === 0) report(`Scanning ${i + 1}/${dbDirs.length}...`);
    try {
      const db = readDatabase(SQL, dbPath);
      const workspacePath = getWorkspacePath(workspaceDir);
      const workspaceName = getWorkspaceName(workspaceDir);

      if (globalDbExists) {
        const composers = getComposerIdsFromDb(db);
        for (let ci = 0; ci < composers.length; ci++) {
          const composer = composers[ci];
          const messages = allBubbles
            ? (allBubbles.get(composer.composerId) ?? [])
            : (globalDb ? getBubblesForComposerFromDb(globalDb, composer.composerId) : []);
          if (messages.length === 0) continue;

          const text = messages.map(m => m.content).join('\n');
          const firstUser = messages.find(m => m.role === 'user');
          const title = composer.name || (firstUser?.content ?? messages[0].content).slice(0, 120).replace(/\n/g, ' ');
          const lastTs = messages[messages.length - 1]?.timestamp ?? composer.lastUpdatedAt ?? composer.createdAt;

          docs.push({
            id: `${hash}::composer::${composer.composerId}`,
            text,
            workspaceHash: hash,
            tabIndex: ci,
            workspacePath,
            workspaceName,
            title,
            messageCount: messages.length,
            timestamp: lastTs,
          });
        }
      }

      db.close();
    } catch (err) {
      stats.failed++;
      recordError(stats, `Cannot read ${dbPath}: ${errorMessage(err)}`);
    }
  }

  if (globalDb) {
    globalDb.close();
  }

  return docs;
}

export async function getChatContentFromWorkspaceStorage(
  extensionPath: string,
  workspaceHash: string,
  tabIndex: number,
  composerId?: string
): Promise<ChatMessage[]> {
  if (composerId && isVsCodeDocumentId(composerId)) {
    return getVsCodeMessages(composerId);
  }
  const SQL = await loadSqlJs(extensionPath);
  const globalDbPath = getGlobalStateDbPath();

  if (composerId && fs.existsSync(globalDbPath)) {
    const messages = getBubblesForComposerCli(globalDbPath, composerId);
    if (messages.length > 0) return messages;
    try {
      const globalDb = readDatabase(SQL, globalDbPath);
      const msgs = getBubblesForComposerFromDb(globalDb, composerId);
      globalDb.close();
      if (msgs.length > 0) return msgs;
    } catch {
      // ignore
    }
  }

  const storagePath = getWorkspaceStorageDir();
  const wsDbPath = path.join(storagePath, workspaceHash, 'state.vscdb');
  if (!fs.existsSync(wsDbPath)) return [];

  let composers: ComposerMeta[];
  try {
    const wsDb = readDatabase(SQL, wsDbPath);
    composers = getComposerIdsFromDb(wsDb);
    wsDb.close();
  } catch {
    return [];
  }

  if (composers.length > 0 && tabIndex >= 0 && tabIndex < composers.length && fs.existsSync(globalDbPath)) {
    const cid = composers[tabIndex].composerId;
    const messages = getBubblesForComposerCli(globalDbPath, cid);
    if (messages.length > 0) return messages;
    try {
      const globalDb = readDatabase(SQL, globalDbPath);
      const msgs = getBubblesForComposerFromDb(globalDb, cid);
      globalDb.close();
      if (msgs.length > 0) return msgs;
    } catch {
      // ignore
    }
  }

  return [];
}
