import * as vscode from 'vscode';
import {BM25Index, SearchDocument} from './bm25';
import {extractDocumentsForSearch, getChatContentFromWorkspaceStorage} from './chatExtractor';
import {injectChatIntoCurrentWorkspace, formatConversationAsMarkdown} from './workspaceChatInjector';

interface IndexedMeta {
  workspaceHash: string;
  tabIndex: number;
  composerId?: string;
  workspacePath: string;
  workspaceName: string;
  title: string;
}

export class ChatSearchPanel {
  public static currentPanel: ChatSearchPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionPath: string;
  private disposables: vscode.Disposable[] = [];

  private bm25Index: BM25Index = new BM25Index();
  private indexedMeta: Map<string, IndexedMeta> = new Map();
  private isIndexed = false;
  private isIndexing = false;

  public static createOrShow(extensionPath: string): ChatSearchPanel {
    const column = vscode.ViewColumn.One;

    if (ChatSearchPanel.currentPanel) {
      ChatSearchPanel.currentPanel.panel.reveal(column);
      return ChatSearchPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'chatSearcher',
      'Chat Searcher',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    ChatSearchPanel.currentPanel = new ChatSearchPanel(panel, extensionPath);
    return ChatSearchPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, extensionPath: string) {
    this.panel = panel;
    this.extensionPath = extensionPath;

    this.panel.webview.html = this.getHtmlContent();

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'search':
            await this.handleSearch(message.query, message.sort, message.workspaceFilter);
            break;
          case 'getConversation':
            await this.handleGetConversation(message.id);
            break;
          case 'copyToChat':
            await this.handleCopyToChat(message.id);
            break;
          case 'ready':
            await this.ensureIndex();
            break;
        }
      },
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public async reindex(): Promise<void> {
    this.isIndexed = false;
    this.isIndexing = false;
    this.bm25Index.clear();
    this.indexedMeta.clear();
    await this.ensureIndex();
  }

  private async ensureIndex(): Promise<void> {
    if (this.isIndexed || this.isIndexing) {
      return;
    }

    this.isIndexing = true;

    this.panel.webview.postMessage({
      type: 'status',
      message: 'Scanning workspaceStorage for chat tabs...',
    });

    try {
      const docs = await extractDocumentsForSearch(this.extensionPath, (msg) => {
        this.panel.webview.postMessage({type: 'status', message: msg});
      });

      this.panel.webview.postMessage({
        type: 'status',
        message: `Building BM25 index for ${docs.length} chat tab(s)...`,
      });

      const documents: SearchDocument[] = [];

      for (const doc of docs) {
        const composerMatch = doc.id.match(/::composer::(.+)$/);
        this.indexedMeta.set(doc.id, {
          workspaceHash: doc.workspaceHash,
          tabIndex: doc.tabIndex,
          composerId: composerMatch ? composerMatch[1] : undefined,
          workspacePath: doc.workspacePath,
          workspaceName: doc.workspaceName,
          title: doc.title,
        });

        documents.push({
          id: doc.id,
          text: doc.text,
          metadata: {
            title: doc.title,
            workspacePath: doc.workspacePath,
            workspaceName: doc.workspaceName,
            messageCount: doc.messageCount,
            timestamp: doc.timestamp,
            text: doc.text,
          },
        });
      }

      this.bm25Index = new BM25Index(1.5, 0.75);
      this.bm25Index.addDocuments(documents);

      this.isIndexed = true;
      this.isIndexing = false;

      this.panel.webview.postMessage({
        type: 'status',
        message: `Ready! ${this.bm25Index.size} chat tab(s) indexed.`,
      });

      const workspaceSet = new Set<string>();
      for (const [, meta] of this.indexedMeta) {
        if (meta.workspacePath) {
          workspaceSet.add(meta.workspaceName || meta.workspacePath.split('/').pop() || meta.workspacePath);
        }
      }
      const workspaces = [...workspaceSet].sort();

      this.panel.webview.postMessage({
        type: 'indexReady',
        totalConversations: this.bm25Index.size,
        workspaces,
      });
    } catch (error: unknown) {
      this.isIndexing = false;
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.panel.webview.postMessage({
        type: 'error',
        message: `Failed to index chats: ${errorMsg}`,
      });
    }
  }

  private async handleSearch(query: string, sort?: string, workspaceFilter?: string): Promise<void> {
    if (!this.isIndexed) {
      await this.ensureIndex();
    }

    if (!query.trim()) {
      this.panel.webview.postMessage({type: 'results', results: []});
      return;
    }

    const results = this.bm25Index.search(query, 200);

    let formattedResults = results.map((result) => {
      const meta = this.indexedMeta.get(result.id);
      const m = result.metadata || {};
      if (!meta) return null;

      const wsName = m.workspaceName as string || meta.workspaceName || (meta.workspacePath && meta.workspacePath.split('/').pop()) || meta.workspacePath;
      if (workspaceFilter && workspaceFilter !== 'all' && wsName !== workspaceFilter) {
        return null;
      }

      const textForSnippet = (m.text as string) || '';
      const snippet = this.generateSnippet(textForSnippet, query, 300);

      return {
        id: result.id,
        score: Math.round(result.score * 100) / 100,
        title: meta.title,
        workspacePath: meta.workspacePath,
        workspaceName: wsName,
        messageCount: (m.messageCount as number) ?? meta.title.length,
        timestamp: (m.timestamp as number) ?? 0,
        snippet,
      };
    }).filter(Boolean) as {id: string; score: number; title: string; workspacePath: string; workspaceName: string; messageCount: number; timestamp: number; snippet: string}[];

    if (sort === 'date') {
      formattedResults.sort((a, b) => b.timestamp - a.timestamp);
    }

    formattedResults = formattedResults.slice(0, 50);

    this.panel.webview.postMessage({
      type: 'results',
      results: formattedResults,
      query,
    });
  }

  private async handleGetConversation(id: string): Promise<void> {
    const meta = this.indexedMeta.get(id);
    if (!meta) {
      this.panel.webview.postMessage({type: 'toast', message: 'Chat not found', isError: true});
      return;
    }
    const messages = await getChatContentFromWorkspaceStorage(
      this.extensionPath,
      meta.workspaceHash,
      meta.tabIndex,
      meta.composerId
    );
    this.panel.webview.postMessage({
      type: 'conversation',
      id,
      messages,
      title: meta.title,
      workspacePath: meta.workspacePath,
      messageCount: messages.length,
    });
  }

  private async handleCopyToChat(id: string): Promise<void> {
    const meta = this.indexedMeta.get(id);
    if (!meta) {
      this.panel.webview.postMessage({type: 'toast', message: 'Chat not found', isError: true});
      return;
    }
    const messages = await getChatContentFromWorkspaceStorage(
      this.extensionPath,
      meta.workspaceHash,
      meta.tabIndex,
      meta.composerId
    );
    if (messages.length === 0) {
      this.panel.webview.postMessage({type: 'toast', message: 'No messages to copy', isError: true});
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolder) {
      const result = await injectChatIntoCurrentWorkspace(
        this.extensionPath,
        workspaceFolder,
        messages,
        meta.title
      );
      if (result.injected) {
        this.panel.webview.postMessage({
          type: 'toast',
          message: 'Chat added to this workspace. Reload the window (Cmd+Shift+P > Developer: Reload Window) to see it in chat.',
        });
        try {
          await vscode.commands.executeCommand('workbench.action.chat.open');
        } catch {
          // ignore
        }
        return;
      }
    }

    const text = formatConversationAsMarkdown(messages, meta.title);
    await vscode.env.clipboard.writeText(text);
    this.panel.webview.postMessage({
      type: 'toast',
      message: 'Copied to clipboard. Paste into chat with Cmd+V.',
    });
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open');
    } catch {
      // ignore
    }
  }

  private generateSnippet(text: string, query: string, maxLength: number): string {
    const lowerText = text.toLowerCase();
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);

    let bestPos = 0;
    let bestScore = -1;

    const windowSize = maxLength;
    for (let i = 0; i < lowerText.length - 50; i += 20) {
      const window = lowerText.slice(i, i + windowSize);
      let score = 0;
      for (const term of queryTerms) {
        const idx = window.indexOf(term);
        if (idx !== -1) {
          score += 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestPos = i;
      }
    }

    let snippet = text.slice(bestPos, bestPos + maxLength);
    if (bestPos > 0) {
      snippet = '...' + snippet;
    }
    if (bestPos + maxLength < text.length) {
      snippet = snippet + '...';
    }

    return snippet;
  }

  private getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chat Searcher</title>
  <style>
    :root {
      --bg-primary: #1e1e2e;
      --bg-secondary: #181825;
      --bg-surface: #313244;
      --bg-hover: #45475a;
      --text-primary: #cdd6f4;
      --text-secondary: #a6adc8;
      --text-muted: #6c7086;
      --accent: #89b4fa;
      --accent-dim: #74c7ec;
      --green: #a6e3a1;
      --yellow: #f9e2af;
      --red: #f38ba8;
      --border: #45475a;
      --highlight-bg: rgba(249, 226, 175, 0.2);
      --highlight-text: #f9e2af;
      --user-bg: #1e3a5f;
      --assistant-bg: #2a2a3e;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .header {
      padding: 16px 20px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    .header h1 {
      font-size: 16px;
      font-weight: 600;
      color: var(--accent);
      margin-bottom: 12px;
      letter-spacing: -0.3px;
    }

    .search-container {
      position: relative;
    }

    .search-input {
      width: 100%;
      padding: 10px 14px 10px 38px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-primary);
      font-size: 14px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s;
    }

    .search-input:focus {
      border-color: var(--accent);
    }

    .search-input::placeholder {
      color: var(--text-muted);
    }

    .search-icon {
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      font-size: 14px;
    }

    .toolbar {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-top: 10px;
    }

    .toolbar label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .sort-group {
      display: flex;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
    }

    .sort-btn {
      background: var(--bg-surface);
      border: none;
      color: var(--text-secondary);
      padding: 5px 12px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s;
    }

    .sort-btn:not(:last-child) {
      border-right: 1px solid var(--border);
    }

    .sort-btn.active {
      background: var(--accent);
      color: var(--bg-primary);
      font-weight: 600;
    }

    .sort-btn:hover:not(.active) {
      background: var(--bg-hover);
    }

    .workspace-filter {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-primary);
      padding: 5px 10px;
      font-size: 12px;
      font-family: inherit;
      outline: none;
      min-width: 160px;
      max-width: 280px;
      cursor: pointer;
    }

    .workspace-filter:focus {
      border-color: var(--accent);
    }

    .status-bar {
      padding: 8px 20px;
      font-size: 12px;
      color: var(--text-muted);
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    .status-bar.loading {
      color: var(--yellow);
    }

    .status-bar.error {
      color: var(--red);
    }

    .content {
      flex: 1;
      overflow-y: auto;
      padding: 12px 20px;
    }

    .results-header {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .result-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 10px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .result-card:hover {
      border-color: var(--accent);
      background: var(--bg-hover);
    }

    .result-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 6px;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .result-meta {
      display: flex;
      gap: 12px;
      margin-bottom: 8px;
      font-size: 11px;
      color: var(--text-muted);
    }

    .result-meta .score {
      color: var(--green);
      font-weight: 600;
    }

    .result-meta .workspace {
      color: var(--accent-dim);
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .result-snippet {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 80px;
      overflow: hidden;
    }

    .result-snippet mark {
      background: var(--highlight-bg);
      color: var(--highlight-text);
      border-radius: 2px;
      padding: 0 2px;
    }

    .result-actions {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }

    .action-btn {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s;
    }

    .action-btn:hover {
      background: var(--bg-hover);
      border-color: var(--accent);
      color: var(--accent);
    }

    .toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-surface);
      border: 1px solid var(--accent);
      color: var(--text-primary);
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 13px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 1000;
      opacity: 0;
      transition: opacity 0.2s;
    }

    .toast.show {
      opacity: 1;
    }

    .toast.error {
      border-color: var(--red);
    }

    .conversation-view {
      display: none;
      flex-direction: column;
      height: 100%;
    }

    .conversation-view.active {
      display: flex;
    }

    .results-view.hidden {
      display: none;
    }

    .conv-header {
      padding: 12px 20px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }

    .back-btn {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text-primary);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      transition: all 0.15s;
    }

    .back-btn:hover {
      background: var(--bg-hover);
      border-color: var(--accent);
    }

    .conv-title-wrap {
      flex: 1;
      overflow: hidden;
      min-width: 0;
    }

    .conv-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .conv-subtitle {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .conv-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
    }

    .message {
      margin-bottom: 16px;
      padding: 12px 14px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .message-content {
      max-height: none;
      overflow: visible;
    }

    .message.user {
      background: var(--user-bg);
      border-left: 3px solid var(--accent);
    }

    .message.assistant {
      background: var(--assistant-bg);
      border-left: 3px solid var(--green);
    }

    .message-role {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }

    .message.user .message-role {
      color: var(--accent);
    }

    .message.assistant .message-role {
      color: var(--green);
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-muted);
      text-align: center;
      padding: 40px;
    }

    .empty-state .icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.3;
    }

    .empty-state p {
      font-size: 14px;
      line-height: 1.6;
    }

    .spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid var(--text-muted);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 6px;
      vertical-align: middle;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    ::-webkit-scrollbar {
      width: 8px;
    }

    ::-webkit-scrollbar-track {
      background: transparent;
    }

    ::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 4px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: var(--bg-hover);
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Chat Searcher</h1>
    <div class="search-container">
      <span class="search-icon">&#128269;</span>
      <input
        type="text"
        class="search-input"
        id="searchInput"
        placeholder="Search across all your Cursor chats..."
        autofocus
      />
    </div>
    <div class="toolbar">
      <label>Sort:</label>
      <div class="sort-group">
        <button class="sort-btn active" data-sort="relevance">Relevance</button>
        <button class="sort-btn" data-sort="date">Newest</button>
      </div>
      <label>Repo:</label>
      <select class="workspace-filter" id="workspaceFilter">
        <option value="all">All workspaces</option>
      </select>
    </div>
  </div>

  <div class="status-bar loading" id="statusBar">
    <span class="spinner"></span> Initializing...
  </div>

  <div class="results-view" id="resultsView">
    <div class="content" id="resultsContent">
      <div class="empty-state" id="emptyState">
        <div class="icon">&#128172;</div>
        <p>Type a query to search across all your Cursor AI conversations.<br/>
        Uses BM25 ranking for relevance-based results.</p>
      </div>
      <div id="resultsList"></div>
    </div>
  </div>

  <div class="conversation-view" id="conversationView">
    <div class="conv-header">
      <button class="back-btn" id="backBtn">&larr; Back</button>
      <div class="conv-title-wrap">
        <div class="conv-title" id="convTitle"></div>
        <div class="conv-subtitle" id="convSubtitle"></div>
      </div>
      <button class="action-btn" id="convCopyBtn" title="Add as new chat tab">Copy to Chat</button>
    </div>
    <div class="conv-messages" id="convMessages"></div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('searchInput');
    const statusBar = document.getElementById('statusBar');
    const resultsView = document.getElementById('resultsView');
    const resultsContent = document.getElementById('resultsContent');
    const resultsList = document.getElementById('resultsList');
    const emptyState = document.getElementById('emptyState');
    const conversationView = document.getElementById('conversationView');
    const convTitle = document.getElementById('convTitle');
    const convMessages = document.getElementById('convMessages');
    const backBtn = document.getElementById('backBtn');
    const workspaceFilter = document.getElementById('workspaceFilter');

    let debounceTimer;
    let currentQuery = '';
    let currentSort = 'relevance';
    let isReady = false;
    let currentConversationId = '';

    function showToast(message, isError) {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = 'toast show' + (isError ? ' error' : '');
      clearTimeout(toast._timer);
      toast._timer = setTimeout(() => {
        toast.classList.remove('show');
      }, 4000);
    }

    function triggerSearch() {
      const query = searchInput.value.trim();
      currentQuery = query;
      if (query && isReady) {
        vscode.postMessage({
          command: 'search',
          query,
          sort: currentSort,
          workspaceFilter: workspaceFilter.value
        });
      } else if (!query) {
        resultsList.innerHTML = '';
        emptyState.style.display = 'flex';
      }
    }

    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(triggerSearch, 250);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(debounceTimer);
        triggerSearch();
      }
    });

    document.querySelectorAll('.sort-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentSort = btn.getAttribute('data-sort');
        triggerSearch();
      });
    });

    workspaceFilter.addEventListener('change', () => {
      triggerSearch();
    });

    backBtn.addEventListener('click', () => {
      conversationView.classList.remove('active');
      resultsView.classList.remove('hidden');
    });

    document.getElementById('convCopyBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentConversationId) {
        vscode.postMessage({command: 'copyToChat', id: currentConversationId});
      }
    });

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function highlightTerms(text, query) {
      if (!query) return escapeHtml(text);
      let result = escapeHtml(text);
      const terms = query.toLowerCase().split(/\\s+/).filter(t => t.length > 1);
      for (const term of terms) {
        let highlighted = '';
        let lower = result.toLowerCase();
        let lastIdx = 0;
        let idx = lower.indexOf(term);
        while (idx !== -1) {
          highlighted += result.slice(lastIdx, idx) +
            '<mark>' + result.slice(idx, idx + term.length) + '</mark>';
          lastIdx = idx + term.length;
          idx = lower.indexOf(term, lastIdx);
        }
        highlighted += result.slice(lastIdx);
        if (highlighted) result = highlighted;
      }
      return result;
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;

      switch (msg.type) {
        case 'status':
          statusBar.innerHTML = (msg.message.includes('Ready') || msg.message.includes('complete'))
            ? msg.message
            : '<span class="spinner"></span> ' + escapeHtml(msg.message);
          statusBar.className = 'status-bar' + (
            msg.message.includes('Ready') || msg.message.includes('complete') ? '' : ' loading'
          );
          break;

        case 'indexReady':
          isReady = true;
          statusBar.textContent = msg.totalConversations + ' conversations indexed. Ready to search.';
          statusBar.className = 'status-bar';
          if (msg.workspaces && msg.workspaces.length > 0) {
            workspaceFilter.innerHTML = '<option value="all">All workspaces (' + msg.workspaces.length + ')</option>';
            for (const ws of msg.workspaces) {
              const opt = document.createElement('option');
              opt.value = ws;
              opt.textContent = ws;
              workspaceFilter.appendChild(opt);
            }
          }
          searchInput.focus();
          if (currentQuery) {
            triggerSearch();
          }
          break;

        case 'error':
          statusBar.textContent = msg.message;
          statusBar.className = 'status-bar error';
          break;

        case 'results':
          emptyState.style.display = 'none';
          if (msg.results.length === 0) {
            resultsList.innerHTML = '<div class="empty-state"><p>No results found for "' +
              escapeHtml(msg.query || '') + '"</p></div>';
            return;
          }

          let html = '<div class="results-header">' + msg.results.length + ' results</div>';
          for (const r of msg.results) {
            const dateStr = r.timestamp
              ? new Date(r.timestamp).toLocaleDateString('en-US', {year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'})
              : '';
            const safeId = escapeHtml(r.id).replace(/"/g, '&quot;');
            html += '<div class="result-card" data-id="' + safeId + '">' +
              '<div class="result-title">' + escapeHtml(r.title) + '</div>' +
              '<div class="result-meta">' +
                '<span class="score">Score: ' + r.score + '</span>' +
                (dateStr ? '<span>' + dateStr + '</span>' : '') +
                '<span>' + r.messageCount + ' messages</span>' +
                '<span class="workspace" title="' + escapeHtml(r.workspacePath) + '">' +
                  escapeHtml(r.workspaceName || r.workspacePath) + '</span>' +
              '</div>' +
              '<div class="result-actions">' +
                '<button class="action-btn" data-id="' + safeId + '" data-action="copy">Copy to Chat</button>' +
              '</div>' +
              '<div class="result-snippet">' +
                highlightTerms(r.snippet, msg.query) +
              '</div>' +
            '</div>';
          }
          resultsList.innerHTML = html;

          document.querySelectorAll('.result-card').forEach(card => {
            card.addEventListener('click', (e) => {
              if (e.target.closest('.action-btn')) return;
              const id = card.getAttribute('data-id');
              vscode.postMessage({command: 'getConversation', id});
            });
          });

          document.querySelectorAll('.result-actions .action-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const id = btn.getAttribute('data-id');
              const action = btn.getAttribute('data-action');
              if (action === 'copy') {
                vscode.postMessage({command: 'copyToChat', id});
              }
            });
          });
          break;

        case 'conversation':
          currentConversationId = msg.id || '';
          convTitle.textContent = msg.title;
          const convSubtitle = document.getElementById('convSubtitle');
          convSubtitle.textContent = 'Full chat history (' + (msg.messageCount || msg.messages.length) + ' messages)';
          let messagesHtml = '';
          for (const m of msg.messages) {
            const roleClass = m.role === 'user' ? 'user' : 'assistant';
            messagesHtml += '<div class="message ' + roleClass + '">' +
              '<div class="message-role">' + escapeHtml(m.role) + '</div>' +
              '<div class="message-content">' + escapeHtml(m.content) + '</div>' +
            '</div>';
          }
          convMessages.innerHTML = messagesHtml;
          resultsView.classList.add('hidden');
          conversationView.classList.add('active');
          break;

        case 'toast':
          showToast(msg.message || '', !!msg.isError);
          break;
      }
    });

    vscode.postMessage({command: 'ready'});
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    ChatSearchPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
