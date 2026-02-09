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
function getBubblesForComposer(globalDb, composerId) {
    const prefix = `bubbleId:${escapeSqlString(composerId)}:`;
    try {
        const res = globalDb.exec(`SELECT value FROM cursorDiskKV WHERE key LIKE '${prefix}%'`);
        if (res.length === 0 || res[0].values.length === 0)
            return [];
        const rawBubbles = [];
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
                rawBubbles.push({
                    type: bType,
                    text,
                    createdAt: typeof b.createdAt === 'number' ? b.createdAt : undefined,
                    order: i,
                });
            }
            catch {
                // skip unparseable
            }
        }
        if (rawBubbles.length > 0 && rawBubbles[0].createdAt != null) {
            rawBubbles.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        }
        return rawBubbles.map(b => ({
            role: b.type === 1 ? 'user' : 'assistant',
            content: b.text,
            timestamp: b.createdAt,
        }));
    }
    catch {
        return [];
    }
}
function getAllBubblesForWorkspace(globalDb, composerIds) {
    const results = [];
    for (let ci = 0; ci < composerIds.length; ci++) {
        const messages = getBubblesForComposer(globalDb, composerIds[ci]);
        if (messages.length > 0) {
            results.push({ composerIndex: ci, messages, name: composerIds[ci] });
        }
    }
    return results;
}
async function extractDocumentsForSearch(extensionPath, progressCallback) {
    const docs = [];
    const storagePath = getCursorStoragePath();
    if (!fs.existsSync(storagePath))
        return docs;
    const report = (msg) => progressCallback?.(msg);
    const wasmBinary = fs.readFileSync(path.join(extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
    const SQL = await (0, sql_js_1.default)({ wasmBinary: wasmBinary.buffer });
    const globalDbPath = getGlobalStoragePath();
    let globalDb = null;
    if (fs.existsSync(globalDbPath)) {
        try {
            const globalBuf = fs.readFileSync(globalDbPath);
            globalDb = new SQL.Database(new Uint8Array(globalBuf));
        }
        catch {
            // ignore
        }
    }
    const entries = fs.readdirSync(storagePath, { withFileTypes: true });
    const dbDirs = entries.filter((e) => e.isDirectory()).map((e) => ({
        hash: e.name,
        workspaceDir: path.join(storagePath, e.name),
        dbPath: path.join(storagePath, e.name, 'state.vscdb'),
    })).filter((d) => fs.existsSync(d.dbPath));
    report(`Scanning ${dbDirs.length} workspace(s)...`);
    for (let i = 0; i < dbDirs.length; i++) {
        const { hash, workspaceDir, dbPath } = dbDirs[i];
        if (i % 20 === 0)
            report(`Scanning ${i + 1}/${dbDirs.length}...`);
        try {
            const fileBuffer = fs.readFileSync(dbPath);
            const db = new SQL.Database(new Uint8Array(fileBuffer));
            const workspacePath = getWorkspacePath(workspaceDir);
            const workspaceName = getWorkspaceName(workspaceDir);
            let added = 0;
            if (globalDb) {
                const composers = getComposerIdsFromDb(db);
                if (composers.length > 0) {
                    for (let ci = 0; ci < composers.length; ci++) {
                        const composer = composers[ci];
                        const messages = getBubblesForComposer(globalDb, composer.composerId);
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
                        added++;
                    }
                }
            }
            db.close();
            if (added > 0)
                continue;
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
    if (composerId) {
        const globalDbPath = getGlobalStoragePath();
        if (fs.existsSync(globalDbPath)) {
            try {
                const globalBuf = fs.readFileSync(globalDbPath);
                const globalDb = new SQL.Database(new Uint8Array(globalBuf));
                const messages = getBubblesForComposer(globalDb, composerId);
                globalDb.close();
                if (messages.length > 0)
                    return messages;
            }
            catch {
                // fall through
            }
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
    if (composers.length > 0 && tabIndex >= 0 && tabIndex < composers.length) {
        const globalDbPath = getGlobalStoragePath();
        if (fs.existsSync(globalDbPath)) {
            try {
                const globalBuf = fs.readFileSync(globalDbPath);
                const globalDb = new SQL.Database(new Uint8Array(globalBuf));
                const messages = getBubblesForComposer(globalDb, composers[tabIndex].composerId);
                globalDb.close();
                if (messages.length > 0)
                    return messages;
            }
            catch {
                // fall through
            }
        }
    }
    return [];
}
//# sourceMappingURL=chatExtractor.js.map