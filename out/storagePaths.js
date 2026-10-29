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
exports.configureStorage = configureStorage;
exports.getUserDataDir = getUserDataDir;
exports.getWorkspaceStorageDir = getWorkspaceStorageDir;
exports.getGlobalStorageDir = getGlobalStorageDir;
exports.getGlobalStateDbPath = getGlobalStateDbPath;
exports.isCursorHost = isCursorHost;
exports.getHostInfo = getHostInfo;
exports.fileUriToPath = fileUriToPath;
exports.pathBasename = pathBasename;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
let config = {};
function configureStorage(next) {
    config = { ...next };
}
const KNOWN_APP_FOLDERS = ['Cursor', 'Code', 'Code - Insiders', 'Windsurf', 'VSCodium'];
function appDataRoot() {
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
function appFolderFromAppName(appName) {
    const n = appName.toLowerCase();
    if (n.includes('cursor'))
        return 'Cursor';
    if (n.includes('windsurf'))
        return 'Windsurf';
    if (n.includes('vscodium'))
        return 'VSCodium';
    if (n.includes('insiders'))
        return 'Code - Insiders';
    if (n.includes('oss'))
        return 'Code - OSS';
    return 'Code';
}
function isUserDataDir(dir) {
    return fs.existsSync(path.join(dir, 'workspaceStorage')) || fs.existsSync(path.join(dir, 'globalStorage'));
}
/** Walks up from an extension storage path to the enclosing "User" folder. */
function findUserDataDir(start) {
    if (!start)
        return undefined;
    let cur = start;
    for (let i = 0; i < 8; i++) {
        if (path.basename(cur).toLowerCase() === 'user' && isUserDataDir(cur))
            return cur;
        const parent = path.dirname(cur);
        if (parent === cur)
            break;
        cur = parent;
    }
    return undefined;
}
function resolveUserDataDir() {
    const override = config.userDataDirOverride?.trim();
    if (override && isUserDataDir(override)) {
        return { dir: override, source: 'chatSearcher.userDataDir setting' };
    }
    const fromWorkspace = findUserDataDir(config.workspaceStoragePath);
    if (fromWorkspace)
        return { dir: fromWorkspace, source: 'extension workspace storage' };
    const fromGlobal = findUserDataDir(config.globalStoragePath);
    if (fromGlobal)
        return { dir: fromGlobal, source: 'extension global storage' };
    const root = appDataRoot();
    if (config.appName) {
        return { dir: path.join(root, appFolderFromAppName(config.appName), 'User'), source: `default folder for ${config.appName}` };
    }
    // Not running inside an IDE (for example the scripts/ helpers): use the first IDE that has data.
    for (const folder of KNOWN_APP_FOLDERS) {
        const dir = path.join(root, folder, 'User');
        if (isUserDataDir(dir))
            return { dir, source: `first IDE folder found (${folder})` };
    }
    return { dir: path.join(root, 'Cursor', 'User'), source: 'default folder (Cursor)' };
}
function getUserDataDir() {
    return resolveUserDataDir().dir;
}
function getWorkspaceStorageDir() {
    return path.join(getUserDataDir(), 'workspaceStorage');
}
function getGlobalStorageDir() {
    return path.join(getUserDataDir(), 'globalStorage');
}
function getGlobalStateDbPath() {
    return path.join(getGlobalStorageDir(), 'state.vscdb');
}
/** True when the data folder belongs to Cursor, whose chat format differs from VS Code. */
function isCursorHost() {
    if (config.appName)
        return /cursor/i.test(config.appName);
    return path.basename(path.dirname(getUserDataDir())).toLowerCase() === 'cursor';
}
function getHostInfo() {
    const { dir, source } = resolveUserDataDir();
    return { appName: config.appName || '', userDataDir: dir, source, isCursor: isCursorHost() };
}
/**
 * Converts a file:// URI from workspace.json to a native path.
 * On Windows, "file:///c%3A/repos/app" becomes "C:\repos\app" (not "/c:/repos/app"),
 * and "file://server/share/app" becomes "\\server\share\app".
 * Other URI schemes (for example vscode-remote://) are returned decoded.
 */
function fileUriToPath(uri, platform = os.platform()) {
    const decode = (s) => {
        try {
            return decodeURIComponent(s);
        }
        catch {
            return s;
        }
    };
    if (!uri.startsWith('file://'))
        return decode(uri);
    let rest = uri.slice('file://'.length);
    let authority = '';
    const slash = rest.indexOf('/');
    if (slash > 0) {
        authority = rest.slice(0, slash);
        rest = rest.slice(slash);
    }
    let p = decode(rest);
    if (platform === 'win32') {
        if (/^\/[a-zA-Z]:/.test(p))
            p = p.slice(1);
        p = p.replace(/\//g, '\\');
        if (/^[a-z]:/.test(p))
            p = p[0].toUpperCase() + p.slice(1);
        if (authority)
            p = `\\\\${authority}${p}`;
    }
    else if (authority) {
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
function pathBasename(p, platform = os.platform()) {
    const rules = platform === 'win32' ? path.win32 : path.posix;
    return rules.basename(p) || p;
}
//# sourceMappingURL=storagePaths.js.map