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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const searchPanel_1 = require("./searchPanel");
function activate(context) {
    const extensionPath = context.extensionPath;
    const searchCommand = vscode.commands.registerCommand('chatSearcher.search', () => {
        try {
            searchPanel_1.ChatSearchPanel.createOrShow(extensionPath);
        }
        catch (err) {
            vscode.window.showErrorMessage(`Chat Search failed: ${err}`);
        }
    });
    const reindexCommand = vscode.commands.registerCommand('chatSearcher.reindex', async () => {
        try {
            const panel = searchPanel_1.ChatSearchPanel.createOrShow(extensionPath);
            await panel.reindex();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Chat Search reindex failed: ${err}`);
        }
    });
    context.subscriptions.push(searchCommand, reindexCommand);
}
function deactivate() {
    // cleanup handled by disposables
}
//# sourceMappingURL=extension.js.map