import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {execFileSync} from 'child_process';
import initSqlJs, {Database} from 'sql.js';

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

function getCursorStoragePath(): string {
  const home = os.homedir();
  switch (os.platform()) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
    case 'linux':
      return path.join(home, '.config', 'Cursor', 'User', 'workspaceStorage');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'workspaceStorage');
    default:
      throw new Error(`Unsupported platform: ${os.platform()}`);
  }
}

function getGlobalStoragePath(): string {
  const home = os.homedir();
  switch (os.platform()) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'linux':
      return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    default:
      throw new Error(`Unsupported platform: ${os.platform()}`);
  }
}

function getWorkspacePath(workspaceDir: string): string {
  try {
    const workspaceJsonPath = path.join(workspaceDir, 'workspace.json');
    if (fs.existsSync(workspaceJsonPath)) {
      const data = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf-8'));
      if (data.folder) {
        return decodeURIComponent(data.folder).replace(/^file:\/\//, '');
      }
    }
  } catch {
    // ignore
  }
  return workspaceDir;
}

function getWorkspaceName(workspaceDir: string): string {
  const p = getWorkspacePath(workspaceDir);
  return path.basename(p) || p;
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

function loadAllBubblesFromGlobalCli(globalDbPath: string): Map<string, ChatMessage[]> | null {
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

    const output = execFileSync('sqlite3', ['-json', globalDbPath, sql], {
      maxBuffer: 200 * 1024 * 1024,
      encoding: 'utf-8',
    }).toString();

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
  } catch {
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

    const output = execFileSync('sqlite3', ['-json', globalDbPath, sql], {
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8',
    }).toString();

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

export interface ExtractDocumentsOptions {
  maxWorkspaces?: number;
}

export async function extractDocumentsForSearch(
  extensionPath: string,
  progressCallback?: (message: string) => void,
  options?: ExtractDocumentsOptions
): Promise<IndexDocument[]> {
  const docs: IndexDocument[] = [];
  const storagePath = getCursorStoragePath();
  if (!fs.existsSync(storagePath)) return docs;

  const report = (msg: string) => progressCallback?.(msg);
  const wasmBinary = fs.readFileSync(
    path.join(extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  );
  const SQL = await initSqlJs({wasmBinary: wasmBinary.buffer as ArrayBuffer});

  const globalDbPath = getGlobalStoragePath();
  const globalDbExists = fs.existsSync(globalDbPath);

  report('Loading conversation data...');

  let allBubbles: Map<string, ChatMessage[]> | null = null;
  let globalDb: Database | null = null;

  if (globalDbExists) {
    allBubbles = loadAllBubblesFromGlobalCli(globalDbPath);
    if (!allBubbles) {
      try {
        const globalBuf = fs.readFileSync(globalDbPath);
        globalDb = new SQL.Database(new Uint8Array(globalBuf));
      } catch {
        // ignore
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

  report(`Scanning ${dbDirs.length} workspace(s)...`);

  for (let i = 0; i < dbDirs.length; i++) {
    const {hash, workspaceDir, dbPath} = dbDirs[i];
    if (i % 50 === 0) report(`Scanning ${i + 1}/${dbDirs.length}...`);
    try {
      const fileBuffer = fs.readFileSync(dbPath);
      const db = new SQL.Database(new Uint8Array(fileBuffer));
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
    } catch {
      // skip unreadable db
    }
  }

  if (globalDb) {
    globalDb.close();
  }

  report(`Indexed ${docs.length} conversation(s).`);
  return docs;
}

export async function getChatContentFromWorkspaceStorage(
  extensionPath: string,
  workspaceHash: string,
  tabIndex: number,
  composerId?: string
): Promise<ChatMessage[]> {
  const wasmBinary = fs.readFileSync(
    path.join(extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  );
  const SQL = await initSqlJs({wasmBinary: wasmBinary.buffer as ArrayBuffer});
  const globalDbPath = getGlobalStoragePath();

  if (composerId && fs.existsSync(globalDbPath)) {
    const messages = getBubblesForComposerCli(globalDbPath, composerId);
    if (messages.length > 0) return messages;
    try {
      const globalBuf = fs.readFileSync(globalDbPath);
      const globalDb = new SQL.Database(new Uint8Array(globalBuf));
      const msgs = getBubblesForComposerFromDb(globalDb, composerId);
      globalDb.close();
      if (msgs.length > 0) return msgs;
    } catch {
      // ignore
    }
  }

  const storagePath = getCursorStoragePath();
  const wsDbPath = path.join(storagePath, workspaceHash, 'state.vscdb');
  if (!fs.existsSync(wsDbPath)) return [];

  const fileBuffer = fs.readFileSync(wsDbPath);
  const wsDb = new SQL.Database(new Uint8Array(fileBuffer));
  const composers = getComposerIdsFromDb(wsDb);
  wsDb.close();

  if (composers.length > 0 && tabIndex >= 0 && tabIndex < composers.length && fs.existsSync(globalDbPath)) {
    const cid = composers[tabIndex].composerId;
    const messages = getBubblesForComposerCli(globalDbPath, cid);
    if (messages.length > 0) return messages;
    try {
      const globalBuf = fs.readFileSync(globalDbPath);
      const globalDb = new SQL.Database(new Uint8Array(globalBuf));
      const msgs = getBubblesForComposerFromDb(globalDb, cid);
      globalDb.close();
      if (msgs.length > 0) return msgs;
    } catch {
      // ignore
    }
  }

  return [];
}
