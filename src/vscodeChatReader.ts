import * as path from 'path';
import * as fs from 'fs';
import {Database, SqlJsStatic} from 'sql.js';
import type {ChatMessage, IndexDocument} from './chatExtractor';
import {errorMessage, IndexStats, readDatabase, recordError} from './dbUtil';
import {pathBasename} from './storagePaths';

/*
 * Reader for VS Code chat sessions (GitHub Copilot Chat and other chat participants).
 *
 * VS Code keeps one file per session (see ChatSessionStore in
 * src/vs/workbench/contrib/chat/common/model/chatSessionStore.ts):
 *   workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl   VS Code 1.109 and later (mutation log)
 *   workspaceStorage/<hash>/chatSessions/<sessionId>.json    before 1.109 (one JSON object)
 *   globalStorage/emptyWindowChatSessions/<sessionId>.json[l] chats from windows with no folder open
 * Older versions kept all sessions in the workspace state.vscdb under 'interactive.sessions'.
 * Session titles live in the workspace state.vscdb under 'chat.ChatSessionStore.index'.
 */

const SESSION_INDEX_KEY = 'chat.ChatSessionStore.index';
const LEGACY_SESSIONS_KEY = 'interactive.sessions';
const MAX_SESSION_FILE_BYTES = 512 * 1024 * 1024;
export const VSCODE_DOC_MARKER = '::vscode::';

type Json = unknown;
type JsonObject = Record<string, unknown>;
type KeyPath = (string | number)[];

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null;
}

function parentOf(state: Json, keyPath: KeyPath): JsonObject | undefined {
  let cur: unknown = state;
  for (let i = 0; i < keyPath.length - 1; i++) {
    if (!isObject(cur)) return undefined;
    cur = (cur as Record<string | number, unknown>)[keyPath[i]];
  }
  return isObject(cur) ? cur : undefined;
}

/**
 * Rebuilds a session from VS Code's ObjectMutationLog format: one JSON entry per line.
 * kind 0 = initial state, 1 = set a property, 2 = push to (or truncate) an array, 3 = delete a property.
 */
export function replayMutationLog(raw: string): Json {
  let state: Json | undefined;
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let entry: {kind?: number; k?: KeyPath; v?: unknown; i?: number};
    try {
      entry = JSON.parse(text);
    } catch {
      continue; // VS Code may be writing the last line right now
    }
    if (!isObject(entry)) continue;
    if (entry.kind === 0) {
      state = entry.v;
      continue;
    }
    if (state === undefined || !Array.isArray(entry.k)) continue;
    if (entry.k.length === 0) {
      if (entry.kind === 1) state = entry.v;
      continue;
    }
    const parent = parentOf(state, entry.k);
    if (!parent) continue;
    const key = entry.k[entry.k.length - 1] as string;
    if (entry.kind === 1) {
      parent[key] = entry.v;
    } else if (entry.kind === 3) {
      delete parent[key];
    } else if (entry.kind === 2) {
      const arr = Array.isArray(parent[key]) ? (parent[key] as unknown[]) : [];
      if (typeof entry.i === 'number') arr.length = entry.i;
      if (Array.isArray(entry.v)) arr.push(...entry.v);
      parent[key] = arr;
    }
  }
  if (state === undefined) throw new Error('chat session log has no initial entry');
  return state;
}

function readSessionFile(file: string): Json {
  const size = fs.statSync(file).size;
  if (size > MAX_SESSION_FILE_BYTES) throw new Error(`session file is too large (${size} bytes)`);
  const raw = fs.readFileSync(file, 'utf-8');
  return file.toLowerCase().endsWith('.jsonl') ? replayMutationLog(raw) : JSON.parse(raw);
}

function markdownText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (isObject(v) && typeof v.value === 'string') return v.value;
  return '';
}

function requestText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (!isObject(message)) return '';
  if (typeof message.text === 'string' && message.text) return message.text;
  if (Array.isArray(message.parts)) {
    return message.parts.map((p) => (isObject(p) && typeof p.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

function referenceName(part: JsonObject): string {
  if (typeof part.name === 'string' && part.name) return part.name;
  const ref = part.inlineReference;
  if (!isObject(ref)) return '';
  if (typeof ref.name === 'string' && ref.name) return ref.name;
  const uri = isObject(ref.uri) ? ref.uri : ref;
  const p = typeof uri.fsPath === 'string' ? uri.fsPath : (typeof uri.path === 'string' ? uri.path : '');
  return p ? pathBasename(p) : '';
}

/** Flattens a serialized response (markdown parts, inline file references, tool messages) to plain text. */
function responseText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (!Array.isArray(response)) return markdownText(response);
  let out = '';
  const addLine = (s: string) => {
    if (!s) return;
    if (out && !out.endsWith('\n')) out += '\n';
    out += s + '\n';
  };
  for (const part of response) {
    if (typeof part === 'string') {
      out += part;
      continue;
    }
    if (!isObject(part)) continue;
    switch (part.kind) {
      case undefined:
        out += markdownText(part); // a serialized IMarkdownString
        break;
      case 'markdownContent':
        out += markdownText(part.content);
        break;
      case 'inlineReference': {
        const name = referenceName(part);
        if (name) out += '`' + name + '`';
        break;
      }
      case 'toolInvocation':
      case 'toolInvocationSerialized':
        addLine(markdownText(part.pastTenseMessage) || markdownText(part.invocationMessage));
        break;
      case 'progressMessage':
      case 'warning':
      case 'info':
        addLine(markdownText(part.content));
        break;
      default:
        break;
    }
  }
  return out.trim();
}

export function sessionToMessages(session: Json): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const requests = isObject(session) && Array.isArray(session.requests) ? session.requests : [];
  for (const req of requests) {
    if (!isObject(req)) continue;
    const timestamp = typeof req.timestamp === 'number' ? req.timestamp : undefined;
    const question = requestText(req.message).trim();
    if (question) messages.push({role: 'user', content: question, timestamp});
    const answer = responseText(req.response);
    if (answer) {
      const responseTimestamp = typeof req.responseTimestamp === 'number' ? req.responseTimestamp : timestamp;
      messages.push({role: 'assistant', content: answer, timestamp: responseTimestamp});
    }
  }
  return messages;
}

function readItem(db: Database, key: string): string | undefined {
  const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
  try {
    stmt.bind([key]);
    if (!stmt.step()) return undefined;
    const value = stmt.get()[0];
    if (typeof value === 'string') return value;
    if (value instanceof Uint8Array) return Buffer.from(value).toString('utf-8');
    return undefined;
  } finally {
    stmt.free();
  }
}

/** Reads session titles and legacy sessions from a workspace state.vscdb. */
function readWorkspaceDb(SQL: SqlJsStatic, dbPath: string): {titles: Map<string, string>; legacy: Json[]} {
  const titles = new Map<string, string>();
  let legacy: Json[] = [];
  if (!fs.existsSync(dbPath)) return {titles, legacy};
  let db: Database | undefined;
  try {
    db = readDatabase(SQL, dbPath);
    const index = readItem(db, SESSION_INDEX_KEY);
    if (index) {
      const entries = (JSON.parse(index) as {entries?: unknown}).entries;
      if (isObject(entries)) {
        for (const [key, entry] of Object.entries(entries)) {
          if (isObject(entry) && typeof entry.title === 'string' && entry.title) {
            titles.set(typeof entry.sessionId === 'string' ? entry.sessionId : key, entry.title);
          }
        }
      }
    }
    const old = readItem(db, LEGACY_SESSIONS_KEY);
    if (old) {
      const parsed = JSON.parse(old) as unknown;
      if (Array.isArray(parsed)) legacy = parsed;
    }
  } catch {
    // Titles and legacy sessions are optional.
  } finally {
    db?.close();
  }
  return {titles, legacy};
}

/** Lists session files in a folder. When both <id>.jsonl and <id>.json exist, VS Code reads the .jsonl. */
function listSessionFiles(dir: string): {id: string; file: string}[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const byId = new Map<string, {id: string; file: string; isLog: boolean}>();
  for (const name of names) {
    const m = /^(.+)\.(jsonl|json)$/i.exec(name);
    if (!m) continue;
    const isLog = m[2].toLowerCase() === 'jsonl';
    const prev = byId.get(m[1]);
    if (!prev || (isLog && !prev.isLog)) byId.set(m[1], {id: m[1], file: path.join(dir, name), isLog});
  }
  return [...byId.values()];
}

export interface WorkspaceInfo {
  workspacePath: string;
  workspaceName: string;
}

type SessionSource = {file: string} | {messages: ChatMessage[]};

/** Document id -> where to read the full conversation from. */
const sessionSources = new Map<string, SessionSource>();

interface Candidate {
  sessionId: string;
  doc: IndexDocument;
  source: SessionSource;
}

function toCandidate(session: Json, hash: string, tabIndex: number, ws: WorkspaceInfo, fallbackId: string, indexTitle?: string): Candidate | undefined {
  const messages = sessionToMessages(session);
  if (messages.length === 0) return undefined;
  const s = isObject(session) ? session : {};
  const sessionId = typeof s.sessionId === 'string' && s.sessionId ? s.sessionId : fallbackId;
  const firstUser = messages.find((m) => m.role === 'user');
  const title = (typeof s.customTitle === 'string' && s.customTitle)
    || indexTitle
    || (firstUser ?? messages[0]).content.slice(0, 120).replace(/\s+/g, ' ');
  const timestamp = messages[messages.length - 1].timestamp
    ?? (typeof s.lastMessageDate === 'number' ? s.lastMessageDate : undefined)
    ?? (typeof s.creationDate === 'number' ? s.creationDate : undefined);
  return {
    sessionId,
    source: {messages},
    doc: {
      id: `${hash}${VSCODE_DOC_MARKER}${sessionId}`,
      text: [title, ...messages.map((m) => m.content)].join('\n'),
      workspaceHash: hash,
      tabIndex,
      workspacePath: ws.workspacePath,
      workspaceName: ws.workspaceName,
      title,
      messageCount: messages.length,
      timestamp,
    },
  };
}

export function extractVsCodeDocuments(
  SQL: SqlJsStatic,
  workspaceStorageDir: string,
  globalStorageDir: string,
  describeWorkspace: (workspaceDir: string) => WorkspaceInfo,
  report: (message: string) => void,
  stats: IndexStats
): IndexDocument[] {
  // A session can appear in more than one place (for example after a workspace is moved).
  // Keep the copy with the most messages.
  const best = new Map<string, Candidate>();
  const consider = (c: Candidate | undefined) => {
    if (!c) return;
    const prev = best.get(c.sessionId);
    if (!prev || c.doc.messageCount > prev.doc.messageCount
      || (c.doc.messageCount === prev.doc.messageCount && (c.doc.timestamp ?? 0) > (prev.doc.timestamp ?? 0))) {
      best.set(c.sessionId, c);
    }
  };
  let tabIndex = 0;
  const readFiles = (dir: string, hash: string, ws: WorkspaceInfo, titles: Map<string, string>) => {
    for (const f of listSessionFiles(dir)) {
      try {
        const session = readSessionFile(f.file);
        const id = isObject(session) && typeof session.sessionId === 'string' ? session.sessionId : f.id;
        const c = toCandidate(session, hash, tabIndex++, ws, f.id, titles.get(id));
        if (c) c.source = {file: f.file}; // read again on open so the view is current
        consider(c);
      } catch (err) {
        stats.failed++;
        recordError(stats, `Cannot read ${f.file}: ${errorMessage(err)}`);
      }
    }
  };

  let hashes: string[] = [];
  try {
    hashes = fs.readdirSync(workspaceStorageDir, {withFileTypes: true}).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    recordError(stats, `Cannot list ${workspaceStorageDir}: ${errorMessage(err)}`);
  }

  for (let i = 0; i < hashes.length; i++) {
    if (i % 50 === 0) report(`Scanning VS Code chats ${i + 1}/${hashes.length}...`);
    const hash = hashes[i];
    const workspaceDir = path.join(workspaceStorageDir, hash);
    const sessionsDir = path.join(workspaceDir, 'chatSessions');
    const hasFiles = fs.existsSync(sessionsDir);
    const {titles, legacy} = readWorkspaceDb(SQL, path.join(workspaceDir, 'state.vscdb'));
    if (!hasFiles && legacy.length === 0) continue;
    const ws = describeWorkspace(workspaceDir);
    if (hasFiles) readFiles(sessionsDir, hash, ws, titles);
    for (const session of legacy) {
      consider(toCandidate(session, hash, tabIndex++, ws, `${hash}-legacy-${tabIndex}`));
    }
  }

  const noFolder: WorkspaceInfo = {workspacePath: '(no folder)', workspaceName: '(no folder)'};
  readFiles(path.join(globalStorageDir, 'emptyWindowChatSessions'), 'emptyWindow', noFolder, new Map());

  sessionSources.clear();
  const docs: IndexDocument[] = [];
  for (const c of best.values()) {
    sessionSources.set(c.doc.id, c.source);
    docs.push(c.doc);
  }
  return docs;
}

export function isVsCodeDocumentId(id: string): boolean {
  return id.includes(VSCODE_DOC_MARKER);
}

/** Returns the full conversation for a document from extractVsCodeDocuments. */
export function getVsCodeMessages(docId: string): ChatMessage[] {
  const source = sessionSources.get(docId);
  if (!source) return [];
  if ('messages' in source) return source.messages;
  try {
    return sessionToMessages(readSessionFile(source.file));
  } catch {
    return [];
  }
}
