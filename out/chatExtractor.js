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
exports.extractDocumentsForSearch = extractDocumentsForSearch;
exports.getChatContentFromWorkspaceStorage = getChatContentFromWorkspaceStorage;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
const sql_js_1 = __importDefault(require("sql.js"));
function getCursorStoragePath() {
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
function getGlobalStoragePath() {
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
function getWorkspacePath(workspaceDir) {
    try {
        const workspaceJsonPath = path.join(workspaceDir, 'workspace.json');
        if (fs.existsSync(workspaceJsonPath)) {
            const data = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf-8'));
            if (data.folder) {
                return decodeURIComponent(data.folder).replace(/^file:\/\//, '');
            }
        }
    }
    catch {
        // ignore
    }
    return workspaceDir;
}
function getWorkspaceName(workspaceDir) {
    const p = getWorkspacePath(workspaceDir);
    return path.basename(p) || p;
}
function escapeSqlString(s) {
    return s.replace(/'/g, "''");
}
function getComposerIdsFromDb(db) {
    try {
        const res = db.exec("SELECT value FROM ItemTable WHERE key = 'composer.composerData'");
        if (res.length === 0 || res[0].values.length === 0)
            return [];
        const val = res[0].values[0][0];
        if (typeof val !== 'string')
            return [];
        const parsed = JSON.parse(val);
        const composers = parsed.allComposers;
        if (!Array.isArray(composers))
            return [];
        return composers.map((c) => {
            const comp = c;
            return {
                composerId: String(comp.composerId || ''),
                name: String(comp.name || ''),
                createdAt: typeof comp.createdAt === 'number' ? comp.createdAt : undefined,
                lastUpdatedAt: typeof comp.lastUpdatedAt === 'number' ? comp.lastUpdatedAt : undefined,
            };
        }).filter(c => c.composerId);
    }
    catch {
        return [];
    }
}
function rawBubblesToMessages(bubbles) {
    if (bubbles.length === 0)
        return [];
    if (bubbles[0].createdAt != null) {
        bubbles.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    }
    return bubbles.map(b => ({
        role: b.type === 1 ? 'user' : 'assistant',
        content: b.text,
        timestamp: b.createdAt,
    }));
}
function loadAllBubblesFromGlobalCli(globalDbPath) {
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
        const output = (0, child_process_1.execFileSync)('sqlite3', ['-json', globalDbPath, sql], {
            maxBuffer: 200 * 1024 * 1024,
            encoding: 'utf-8',
        }).toString();
        const rows = JSON.parse(output || '[]');
        const composerBubbles = new Map();
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row.text || !row.text.trim())
                continue;
            const firstColon = row.key.indexOf(':');
            const secondColon = row.key.indexOf(':', firstColon + 1);
            if (firstColon < 0 || secondColon < 0)
                continue;
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
        const result = new Map();
        for (const [composerId, bubbles] of composerBubbles) {
            result.set(composerId, rawBubblesToMessages(bubbles));
        }
        return result;
    }
    catch {
        return null;
    }
}
function getBubblesForComposerCli(globalDbPath, composerId) {
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
        const output = (0, child_process_1.execFileSync)('sqlite3', ['-json', globalDbPath, sql], {
            maxBuffer: 50 * 1024 * 1024,
            encoding: 'utf-8',
        }).toString();
        const rows = JSON.parse(output || '[]');
        const bubbles = [];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row.text || !row.text.trim())
                continue;
            bubbles.push({
                type: row.type,
                text: row.text.trim(),
                createdAt: typeof row.createdAt === 'number' ? row.createdAt : undefined,
                order: i,
            });
        }
        return rawBubblesToMessages(bubbles);
    }
    catch {
        return [];
    }
}
function getBubblesForComposerFromDb(globalDb, composerId) {
    try {
        const prefix = `bubbleId:${escapeSqlString(composerId)}:`;
        const res = globalDb.exec(`SELECT value FROM cursorDiskKV WHERE key LIKE '${prefix}%'`);
        if (res.length === 0 || res[0].values.length === 0)
            return [];
        const bubbles = [];
        for (let i = 0; i < res[0].values.length; i++) {
            const val = res[0].values[i][0];
            if (typeof val !== 'string')
                continue;
            try {
                const b = JSON.parse(val);
                const bType = b.type;
                if (bType !== 1 && bType !== 2)
                    continue;
                const text = String(b.text ?? b.rawText ?? b.content ?? '').trim();
                if (!text)
                    continue;
                bubbles.push({
                    type: bType,
                    text,
                    createdAt: typeof b.createdAt === 'number' ? b.createdAt : undefined,
                    order: i,
                });
            }
            catch {
                // skip
            }
        }
        return rawBubblesToMessages(bubbles);
    }
    catch {
        return [];
    }
}
async function extractDocumentsForSearch(extensionPath, progressCallback, options) {
    const docs = [];
    const storagePath = getCursorStoragePath();
    if (!fs.existsSync(storagePath))
        return docs;
    const report = (msg) => progressCallback?.(msg);
    const wasmBinary = fs.readFileSync(path.join(extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
    const SQL = await (0, sql_js_1.default)({ wasmBinary: wasmBinary.buffer });
    const globalDbPath = getGlobalStoragePath();
    const globalDbExists = fs.existsSync(globalDbPath);
    report('Loading conversation data...');
    let allBubbles = null;
    let globalDb = null;
    if (globalDbExists) {
        allBubbles = loadAllBubblesFromGlobalCli(globalDbPath);
        if (!allBubbles) {
            try {
                const globalBuf = fs.readFileSync(globalDbPath);
                globalDb = new SQL.Database(new Uint8Array(globalBuf));
            }
            catch {
                // ignore
            }
        }
    }
    if (allBubbles) {
        report(`Loaded ${allBubbles.size} conversation(s) from global storage.`);
    }
    const maxWorkspaces = options?.maxWorkspaces;
    const entries = fs.readdirSync(storagePath, { withFileTypes: true });
    const allDbDirs = entries.filter((e) => e.isDirectory()).map((e) => ({
        hash: e.name,
        workspaceDir: path.join(storagePath, e.name),
        dbPath: path.join(storagePath, e.name, 'state.vscdb'),
    })).filter((d) => fs.existsSync(d.dbPath));
    const dbDirs = typeof maxWorkspaces === 'number' ? allDbDirs.slice(0, maxWorkspaces) : allDbDirs;
    report(`Scanning ${dbDirs.length} workspace(s)...`);
    for (let i = 0; i < dbDirs.length; i++) {
        const { hash, workspaceDir, dbPath } = dbDirs[i];
        if (i % 50 === 0)
            report(`Scanning ${i + 1}/${dbDirs.length}...`);
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
                    if (messages.length === 0)
                        continue;
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
        }
        catch {
            // skip unreadable db
        }
    }
    if (globalDb) {
        globalDb.close();
    }
    report(`Indexed ${docs.length} conversation(s).`);
    return docs;
}
async function getChatContentFromWorkspaceStorage(extensionPath, workspaceHash, tabIndex, composerId) {
    const wasmBinary = fs.readFileSync(path.join(extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
    const SQL = await (0, sql_js_1.default)({ wasmBinary: wasmBinary.buffer });
    const globalDbPath = getGlobalStoragePath();
    if (composerId && fs.existsSync(globalDbPath)) {
        const messages = getBubblesForComposerCli(globalDbPath, composerId);
        if (messages.length > 0)
            return messages;
        try {
            const globalBuf = fs.readFileSync(globalDbPath);
            const globalDb = new SQL.Database(new Uint8Array(globalBuf));
            const msgs = getBubblesForComposerFromDb(globalDb, composerId);
            globalDb.close();
            if (msgs.length > 0)
                return msgs;
        }
        catch {
            // ignore
        }
    }
    const storagePath = getCursorStoragePath();
    const wsDbPath = path.join(storagePath, workspaceHash, 'state.vscdb');
    if (!fs.existsSync(wsDbPath))
        return [];
    const fileBuffer = fs.readFileSync(wsDbPath);
    const wsDb = new SQL.Database(new Uint8Array(fileBuffer));
    const composers = getComposerIdsFromDb(wsDb);
    wsDb.close();
    if (composers.length > 0 && tabIndex >= 0 && tabIndex < composers.length && fs.existsSync(globalDbPath)) {
        const cid = composers[tabIndex].composerId;
        const messages = getBubblesForComposerCli(globalDbPath, cid);
        if (messages.length > 0)
            return messages;
        try {
            const globalBuf = fs.readFileSync(globalDbPath);
            const globalDb = new SQL.Database(new Uint8Array(globalBuf));
            const msgs = getBubblesForComposerFromDb(globalDb, cid);
            globalDb.close();
            if (msgs.length > 0)
                return msgs;
        }
        catch {
            // ignore
        }
    }
    return [];
}
//# sourceMappingURL=chatExtractor.js.map