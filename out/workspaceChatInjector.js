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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.injectChatIntoCurrentWorkspace = injectChatIntoCurrentWorkspace;
exports.formatConversationAsMarkdown = formatConversationAsMarkdown;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
const sql_js_1 = __importDefault(require("sql.js"));
const CHAT_KEY = 'workbench.panel.aichat.view.aichat.chatdata';
function getCursorStoragePath() {
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
function computeWorkspaceStorageHash(workspaceFolderPath) {
    const stat = fs.statSync(workspaceFolderPath);
    const salt = os.platform() === 'linux' ? String(stat.ino) : String(stat.birthtimeMs);
    const input = workspaceFolderPath + salt;
    return crypto.createHash('md5').update(input).digest('hex');
}
function messagesToBubbles(messages) {
    return messages
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'context')
        .map((m) => ({
        role: m.role === 'context' ? 'assistant' : m.role,
        text: m.content,
    }));
}
async function injectChatIntoCurrentWorkspace(extensionPath, workspaceFolderPath, messages, title) {
    const bubbles = messagesToBubbles(messages);
    if (bubbles.length === 0) {
        return { injected: false, error: 'No messages to copy' };
    }
    const storagePath = getCursorStoragePath();
    if (!fs.existsSync(storagePath)) {
        return { injected: false, error: 'Cursor workspace storage not found' };
    }
    let hash;
    try {
        hash = computeWorkspaceStorageHash(workspaceFolderPath);
    }
    catch {
        return { injected: false, error: 'Could not compute workspace hash' };
    }
    const dbPath = path.join(storagePath, hash, 'state.vscdb');
    if (!fs.existsSync(dbPath)) {
        return { injected: false, error: 'Workspace database not found' };
    }
    const wasmBinary = fs.readFileSync(path.join(extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
    const SQL = await (0, sql_js_1.default)({ wasmBinary: wasmBinary.buffer });
    try {
        const fileBuffer = fs.readFileSync(dbPath);
        const db = new SQL.Database(new Uint8Array(fileBuffer));
        const results = db.exec(`SELECT value FROM ItemTable WHERE key = '${CHAT_KEY.replace(/'/g, "''")}'`);
        let data;
        if (results.length > 0 && results[0].values.length > 0) {
            const value = results[0].values[0][0];
            try {
                data = typeof value === 'string' ? JSON.parse(value) : { tabs: [] };
            }
            catch {
                data = { tabs: [] };
            }
        }
        else {
            data = { tabs: [] };
        }
        if (!Array.isArray(data.tabs)) {
            data.tabs = [];
        }
        const newTab = {
            bubbles: bubbles.map((b) => ({ role: b.role, text: b.text })),
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
    }
    catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { injected: false, error: errorMsg };
    }
    return { injected: true };
}
function formatConversationAsMarkdown(messages, title) {
    const lines = [];
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
//# sourceMappingURL=workspaceChatInjector.js.map