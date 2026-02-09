# Chat Searcher

Search across **all** your AI chat history using BM25 text ranking.

Ever had a great conversation with your AI coding assistant and couldn't find it later? This extension indexes every chat conversation across all your workspaces and lets you search through them instantly.

Works with **Cursor**, **Windsurf**, and other VS Code-based IDEs.

## Features

- **Full-text search** across all AI conversations using the BM25 ranking algorithm
- **Correct user/assistant roles** -- reads the actual conversation bubbles from storage, not just prompts
- **Filter by workspace** -- narrow results to a specific project
- **Sort by relevance or date** -- find the most relevant or most recent conversations
- **View full chat history** -- click any result to see the complete conversation with all messages
- **Copy to Chat** -- inject a past conversation into your current workspace's chat

## Usage

1. Press `Cmd+Shift+H` (macOS) or `Ctrl+Shift+H` (Windows/Linux) to open the search panel
2. Type your search query
3. Click a result to view the full conversation
4. Use "Copy to Chat" to bring a past conversation into your current workspace

You can also open it from the Command Palette: `Chat Searcher: Search Chats`

To rebuild the index after new conversations: `Chat Searcher: Reindex All Chats`

## How It Works

The extension reads the IDE's internal storage (SQLite databases in `workspaceStorage` and `globalStorage`) to extract chat conversations. It indexes them using the BM25 algorithm for fast, relevance-ranked text search.

All data stays local on your machine. Nothing is sent to any external service.

## Requirements

- A VS Code-based IDE with AI chat features (Cursor, Windsurf, etc.)

## License

MIT
