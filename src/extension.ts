import * as vscode from 'vscode';
import {ChatSearchPanel} from './searchPanel';

export function activate(context: vscode.ExtensionContext) {
  const extensionPath = context.extensionPath;

  const searchCommand = vscode.commands.registerCommand(
    'chatSearcher.search',
    () => {
      try {
        ChatSearchPanel.createOrShow(extensionPath);
      } catch (err) {
        vscode.window.showErrorMessage(`Chat Search failed: ${err}`);
      }
    }
  );

  const reindexCommand = vscode.commands.registerCommand(
    'chatSearcher.reindex',
    async () => {
      try {
        const panel = ChatSearchPanel.createOrShow(extensionPath);
        await panel.reindex();
      } catch (err) {
        vscode.window.showErrorMessage(`Chat Search reindex failed: ${err}`);
      }
    }
  );

  context.subscriptions.push(searchCommand, reindexCommand);
}

export function deactivate() {
  // cleanup handled by disposables
}
