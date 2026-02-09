import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import initSqlJs from 'sql.js';
import {ChatMessage} from './chatExtractor';

const CHAT_KEY = 'workbench.panel.aichat.view.aichat.chatdata';

function getCursorStoragePath(): string {
  const platform = os.platform();
  const home = os.homedir();
  switch (platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
    case 'linux':
      return path.join(home, '.config', 'Cursor', 'User', 'workspaceStorage');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'workspaceStorage');
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

function computeWorkspaceStorageHash(workspaceFolderPath: string): string {
  const stat = fs.statSync(workspaceFolderPath);
  const salt = os.platform() === 'linux' ? String(stat.ino) : String(stat.birthtimeMs);
  const input = workspaceFolderPath + salt;
  return crypto.createHash('md5').update(input).digest('hex');
}

function messagesToBubbles(messages: ChatMessage[]): {role: string; text: string}[] {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'context')
    .map((m) => ({
      role: m.role === 'context' ? 'assistant' : m.role,
      text: m.content,
    }));
}

export async function injectChatIntoCurrentWorkspace(
  extensionPath: string,
  workspaceFolderPath: string,
  messages: ChatMessage[],
  title: string
): Promise<{injected: boolean; error?: string}> {
  const bubbles = messagesToBubbles(messages);
  if (bubbles.length === 0) {
    return {injected: false, error: 'No messages to copy'};
  }

  const storagePath = getCursorStoragePath();
  if (!fs.existsSync(storagePath)) {
    return {injected: false, error: 'Cursor workspace storage not found'};
  }

  let hash: string;
  try {
    hash = computeWorkspaceStorageHash(workspaceFolderPath);
  } catch {
    return {injected: false, error: 'Could not compute workspace hash'};
  }

  const dbPath = path.join(storagePath, hash, 'state.vscdb');
  if (!fs.existsSync(dbPath)) {
    return {injected: false, error: 'Workspace database not found'};
  }

  const wasmBinary = fs.readFileSync(
    path.join(extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  );
  const SQL = await initSqlJs({wasmBinary: wasmBinary.buffer as ArrayBuffer});

  try {
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(new Uint8Array(fileBuffer));

    const results = db.exec(`SELECT value FROM ItemTable WHERE key = '${CHAT_KEY.replace(/'/g, "''")}'`);
    let data: {tabs?: unknown[]};
    if (results.length > 0 && results[0].values.length > 0) {
      const value = results[0].values[0][0];
      try {
        data = typeof value === 'string' ? JSON.parse(value) : {tabs: []};
      } catch {
        data = {tabs: []};
      }
    } else {
      data = {tabs: []};
    }

    if (!Array.isArray(data.tabs)) {
      data.tabs = [];
    }

    const newTab = {
      bubbles: bubbles.map((b) => ({role: b.role, text: b.text})),
    };
    data.tabs.push(newTab);

    const newValue = JSON.stringify(data);
    db.run(`UPDATE ItemTable SET value = ? WHERE key = ?`, [newValue, CHAT_KEY]);
    if (db.getRowsModified() === 0) {
      db.run(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`, [CHAT_KEY, newValue]);
    }

    const exported = db.export();
    db.close();
    fs.writeFileSync(dbPath, Buffer.from(exported));
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {injected: false, error: errorMsg};
  }

  return {injected: true};
}

export function formatConversationAsMarkdown(messages: ChatMessage[], title?: string): string {
  const lines: string[] = [];
  if (title) {
    lines.push(`## ${title}\n`);
  }
  for (const m of messages) {
    if (m.role === 'context') {
      continue;
    }
    const label = m.role === 'user' ? '**User**' : '**Assistant**';
    lines.push(`${label}:\n${m.content}\n`);
  }
  return lines.join('\n');
}
