# Chat Searcher

Never lose an AI conversation again. **Chat Searcher** indexes every chat across all your workspaces and lets you find any past conversation in seconds.

Works with **Cursor**, **Windsurf**, and other VS Code-based IDEs.

## Why?

AI coding assistants don't have a built-in way to search your chat history. Once a conversation scrolls away, it's gone. Chat Searcher fixes that -- it reads your IDE's local storage, indexes everything, and gives you instant full-text search across all your projects.

## Features

- **Instant full-text search** -- find any conversation by keyword using the BM25 ranking algorithm
- **Lightning-fast indexing** -- indexes hundreds of conversations in ~4 seconds using a single optimized SQLite query
- **Cross-workspace** -- searches across all your projects at once, with filtering by workspace
- **Full conversation view** -- click any result to see the complete chat with all messages
- **Correct roles** -- properly distinguishes user messages from assistant responses
- **Copy to Chat** -- bring any past conversation into your current workspace's chat
- **Sort by relevance or date** -- find the most relevant or most recent conversations
- **100% local** -- all data stays on your machine. Nothing is sent anywhere.
- **Low memory footprint** -- uses the native `sqlite3` CLI to query large databases without loading them into memory

## Quick Start

1. Install the extension
2. Press `Cmd+Shift+H` (macOS) or `Ctrl+Shift+H` (Windows/Linux)
3. Type your search query
4. Click a result to view the full conversation

That's it. The index is built automatically the first time you open the search panel.

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| **Chat Searcher: Search Chats** | `Cmd+Shift+H` / `Ctrl+Shift+H` | Open the search panel |
| **Chat Searcher: Reindex All Chats** | -- | Rebuild the index (run after new conversations) |

## How It Works

1. Reads composer metadata from each workspace's local `state.vscdb` (small SQLite files, ~100KB each)
2. Fetches all conversation bubbles from the global `state.vscdb` in a single query using `json_extract` -- extracting only the fields needed (role, text, timestamp), not the full multi-KB JSON blobs
3. Groups bubbles by conversation and builds a BM25 search index in memory
4. Search queries return results ranked by relevance with highlighted snippets

The global storage database can be 2+ GB, but Chat Searcher never loads it into memory. It uses the system `sqlite3` CLI for zero-copy querying, with a fallback to `sql.js` for systems where the CLI isn't available.

## Supported IDEs

- Cursor
- Windsurf
- Any VS Code-based IDE that stores AI chat in `workspaceStorage`/`globalStorage`

## Requirements

- macOS, Linux, or Windows
- `sqlite3` CLI (pre-installed on macOS and most Linux distros; optional on Windows -- falls back to in-memory loading)

## Privacy

Chat Searcher is fully offline. It reads only local SQLite files on your machine. No network requests, no telemetry, no data collection.

## License

MIT -- [Alexander Goldberg](https://github.com/alexandergolbergwix)
