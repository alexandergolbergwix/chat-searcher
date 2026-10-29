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
const sql_js_1 = __importDefault(require("sql.js"));
const dbUtil_1 = require("./dbUtil");
const storagePaths_1 = require("./storagePaths");
const vscodeChatReader_1 = require("./vscodeChatReader");
function getWorkspacePath(workspaceDir) {
    try {
        const workspaceJsonPath = path.join(workspaceDir, 'workspace.json');
        if (fs.existsSync(workspaceJsonPath)) {
            const data = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf-8'));
            if (typeof data.folder === 'string' && data.folder) {
                return (0, storagePaths_1.fileUriToPath)(data.folder);
            }
            if (typeof data.workspace === 'string' && data.workspace) {
                return (0, storagePaths_1.fileUriToPath)(data.workspace);
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
    return (0, storagePaths_1.pathBasename)(p).replace(/\.code-workspace$/i, '') || p;
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
function loadAllBubblesFromGlobalCli(globalDbPath, stats) {
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
        const output = (0, dbUtil_1.runSqliteCli)(globalDbPath, sql, 200 * 1024 * 1024);
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
    catch (err) {
        (0, dbUtil_1.recordError)(stats, (0, dbUtil_1.errorMessage)(err));
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
        const output = (0, dbUtil_1.runSqliteCli)(globalDbPath, sql, 50 * 1024 * 1024);
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
function summarizeIndex(count, stats) {
    let summary = `Indexed ${count} conversation(s) from ${(0, storagePaths_1.getUserDataDir)()}.`;
    if (stats.failed > 0)
        summary += ` ${stats.failed} file(s) could not be read.`;
    if (stats.errors.length > 0)
        summary += ` First problem: ${stats.errors[0]}`;
    return summary;
}
function loadSqlJs(extensionPath) {
    const wasmBinary = fs.readFileSync(path.join(extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
    return (0, sql_js_1.default)({ wasmBinary: wasmBinary.buffer });
}
function describeWorkspace(workspaceDir) {
    return { workspacePath: getWorkspacePath(workspaceDir), workspaceName: getWorkspaceName(workspaceDir) };
}
async function extractDocumentsForSearch(extensionPath, progressCallback, options) {
    const report = (msg) => progressCallback?.(msg);
    const stats = { failed: 0, errors: [] };
    const storagePath = (0, storagePaths_1.getWorkspaceStorageDir)();
    if (!fs.existsSync(storagePath)) {
        report(`No chat storage found: ${storagePath} does not exist.`);
        return [];
    }
    const SQL = await loadSqlJs(extensionPath);
    let docs = [];
    // Cursor keeps chats in its own tables. VS Code keeps one file per chat session.
    if ((0, storagePaths_1.isCursorHost)()) {
        docs = docs.concat(extractCursorDocuments(SQL, storagePath, report, stats, options));
    }
    let vscodeDocs = (0, vscodeChatReader_1.extractVsCodeDocuments)(SQL, storagePath, (0, storagePaths_1.getGlobalStorageDir)(), describeWorkspace, report, stats);
    if (typeof options?.maxWorkspaces === 'number') {
        const keep = new Set([...new Set(vscodeDocs.map((d) => d.workspaceHash))].slice(0, options.maxWorkspaces));
        vscodeDocs = vscodeDocs.filter((d) => keep.has(d.workspaceHash));
    }
    docs = docs.concat(vscodeDocs);
    report(summarizeIndex(docs.length, stats));
    return docs;
}
function extractCursorDocuments(SQL, storagePath, report, stats, options) {
    const docs = [];
    const globalDbPath = (0, storagePaths_1.getGlobalStateDbPath)();
    const globalDbExists = fs.existsSync(globalDbPath);
    report('Loading Cursor conversation data...');
    (0, dbUtil_1.resetSqliteCliSupport)();
    let allBubbles = null;
    let globalDb = null;
    if (globalDbExists) {
        allBubbles = loadAllBubblesFromGlobalCli(globalDbPath, stats);
        if (!allBubbles) {
            try {
                globalDb = (0, dbUtil_1.readDatabase)(SQL, globalDbPath);
            }
            catch (err) {
                (0, dbUtil_1.recordError)(stats, `Cannot load ${globalDbPath}: ${(0, dbUtil_1.errorMessage)(err)}`);
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
    report(`Scanning ${dbDirs.length} Cursor workspace(s)...`);
    for (let i = 0; i < dbDirs.length; i++) {
        const { hash, workspaceDir, dbPath } = dbDirs[i];
        if (i % 50 === 0)
            report(`Scanning ${i + 1}/${dbDirs.length}...`);
        try {
            const db = (0, dbUtil_1.readDatabase)(SQL, dbPath);
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
        catch (err) {
            stats.failed++;
            (0, dbUtil_1.recordError)(stats, `Cannot read ${dbPath}: ${(0, dbUtil_1.errorMessage)(err)}`);
        }
    }
    if (globalDb) {
        globalDb.close();
    }
    return docs;
}
async function getChatContentFromWorkspaceStorage(extensionPath, workspaceHash, tabIndex, composerId) {
    if (composerId && (0, vscodeChatReader_1.isVsCodeDocumentId)(composerId)) {
        return (0, vscodeChatReader_1.getVsCodeMessages)(composerId);
    }
    const SQL = await loadSqlJs(extensionPath);
    const globalDbPath = (0, storagePaths_1.getGlobalStateDbPath)();
    if (composerId && fs.existsSync(globalDbPath)) {
        const messages = getBubblesForComposerCli(globalDbPath, composerId);
        if (messages.length > 0)
            return messages;
        try {
            const globalDb = (0, dbUtil_1.readDatabase)(SQL, globalDbPath);
            const msgs = getBubblesForComposerFromDb(globalDb, composerId);
            globalDb.close();
            if (msgs.length > 0)
                return msgs;
        }
        catch {
            // ignore
        }
    }
    const storagePath = (0, storagePaths_1.getWorkspaceStorageDir)();
    const wsDbPath = path.join(storagePath, workspaceHash, 'state.vscdb');
    if (!fs.existsSync(wsDbPath))
        return [];
    let composers;
    try {
        const wsDb = (0, dbUtil_1.readDatabase)(SQL, wsDbPath);
        composers = getComposerIdsFromDb(wsDb);
        wsDb.close();
    }
    catch {
        return [];
    }
    if (composers.length > 0 && tabIndex >= 0 && tabIndex < composers.length && fs.existsSync(globalDbPath)) {
        const cid = composers[tabIndex].composerId;
        const messages = getBubblesForComposerCli(globalDbPath, cid);
        if (messages.length > 0)
            return messages;
        try {
            const globalDb = (0, dbUtil_1.readDatabase)(SQL, globalDbPath);
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