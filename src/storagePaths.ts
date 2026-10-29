import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Locates the IDE's "User" data directory (the folder that contains
 * workspaceStorage/ and globalStorage/).
 *
 * The extension runs inside many VS Code-based IDEs (VS Code, Cursor, ...),
 * and each one keeps its data in a different folder. The running IDE tells us
 * where its storage is through the extension context, so we prefer that over
 * a hard-coded folder name.
 */
export interface StorageConfig {
  /** vscode.env.appName, e.g. "Visual Studio Code" or "Cursor". */
  appName?: string;
  /** context.globalStorageUri.fsPath */
  globalStoragePath?: string;
  /** context.storageUri?.fsPath */
  workspaceStoragePath?: string;
  /** Value of the chatSearcher.userDataDir setting. */
  userDataDirOverride?: string;
}

export interface HostInfo {
  appName: string;
  userDataDir: string;
  source: string;
  isCursor: boolean;
}

let config: StorageConfig = {};

export function configureStorage(next: StorageConfig): void {
  config = {...next};
}

const KNOWN_APP_FOLDERS = ['Cursor', 'Code', 'Code - Insiders', 'Windsurf', 'VSCodium'];

function appDataRoot(): string {
  const home = os.homedir();
  switch (os.platform()) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support');
    case 'win32':
      return process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    default:
      return process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  }
}

function appFolderFromAppName(appName: string): string {
  const n = appName.toLowerCase();
  if (n.includes('cursor')) return 'Cursor';
  if (n.includes('windsurf')) return 'Windsurf';
  if (n.includes('vscodium')) return 'VSCodium';
  if (n.includes('insiders')) return 'Code - Insiders';
  if (n.includes('oss')) return 'Code - OSS';
  return 'Code';
}

function isUserDataDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'workspaceStorage')) || fs.existsSync(path.join(dir, 'globalStorage'));
}

/** Walks up from an extension storage path to the enclosing "User" folder. */
function findUserDataDir(start: string | undefined): string | undefined {
  if (!start) return undefined;
  let cur = start;
  for (let i = 0; i < 8; i++) {
    if (path.basename(cur).toLowerCase() === 'user' && isUserDataDir(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return undefined;
}

function resolveUserDataDir(): {dir: string; source: string} {
  const override = config.userDataDirOverride?.trim();
  if (override && isUserDataDir(override)) {
    return {dir: override, source: 'chatSearcher.userDataDir setting'};
  }
  const fromWorkspace = findUserDataDir(config.workspaceStoragePath);
  if (fromWorkspace) return {dir: fromWorkspace, source: 'extension workspace storage'};
  const fromGlobal = findUserDataDir(config.globalStoragePath);
  if (fromGlobal) return {dir: fromGlobal, source: 'extension global storage'};

  const root = appDataRoot();
  if (config.appName) {
    return {dir: path.join(root, appFolderFromAppName(config.appName), 'User'), source: `default folder for ${config.appName}`};
  }
  // Not running inside an IDE (for example the scripts/ helpers): use the first IDE that has data.
  for (const folder of KNOWN_APP_FOLDERS) {
    const dir = path.join(root, folder, 'User');
    if (isUserDataDir(dir)) return {dir, source: `first IDE folder found (${folder})`};
  }
  return {dir: path.join(root, 'Cursor', 'User'), source: 'default folder (Cursor)'};
}

export function getUserDataDir(): string {
  return resolveUserDataDir().dir;
}

export function getWorkspaceStorageDir(): string {
  return path.join(getUserDataDir(), 'workspaceStorage');
}

export function getGlobalStorageDir(): string {
  return path.join(getUserDataDir(), 'globalStorage');
}

export function getGlobalStateDbPath(): string {
  return path.join(getGlobalStorageDir(), 'state.vscdb');
}

/** True when the data folder belongs to Cursor, whose chat format differs from VS Code. */
export function isCursorHost(): boolean {
  if (config.appName) return /cursor/i.test(config.appName);
  return path.basename(path.dirname(getUserDataDir())).toLowerCase() === 'cursor';
}

export function getHostInfo(): HostInfo {
  const {dir, source} = resolveUserDataDir();
  return {appName: config.appName || '', userDataDir: dir, source, isCursor: isCursorHost()};
}

/**
 * Converts a file:// URI from workspace.json to a native path.
 * On Windows, "file:///c%3A/repos/app" becomes "C:\repos\app" (not "/c:/repos/app"),
 * and "file://server/share/app" becomes "\\server\share\app".
 * Other URI schemes (for example vscode-remote://) are returned decoded.
 */
export function fileUriToPath(uri: string, platform: NodeJS.Platform = os.platform()): string {
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  if (!uri.startsWith('file://')) return decode(uri);

  let rest = uri.slice('file://'.length);
  let authority = '';
  const slash = rest.indexOf('/');
  if (slash > 0) {
    authority = rest.slice(0, slash);
    rest = rest.slice(slash);
  }
  let p = decode(rest);
  if (platform === 'win32') {
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    p = p.replace(/\//g, '\\');
    if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
    if (authority) p = `\\\\${authority}${p}`;
  } else if (authority) {
    p = `//${authority}${p}`;
  }
  return p;
}

/**
 * Last segment of a path, using the path rules of the platform.
 * On Windows, both "\" and "/" are separators. On macOS and Linux, only "/"
 * is a separator, because "\" is a valid character in a file name there.
 * Paths taken from URIs (for example vscode-remote:// workspaces) use "/",
 * which both rules accept. Trailing separators are ignored.
 */
export function pathBasename(p: string, platform: NodeJS.Platform = os.platform()): string {
  const rules = platform === 'win32' ? path.win32 : path.posix;
  return rules.basename(p) || p;
}
