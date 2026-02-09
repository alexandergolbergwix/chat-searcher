'use strict';
const path = require('path');
const extensionPath = path.resolve(__dirname, '..');

async function main() {
  const {extractDocumentsForSearch, getChatContentFromWorkspaceStorage} = require('../out/chatExtractor.js');

  console.log('=== 1. Quick probe: sqlite3 CLI + global DB ===');
  const os = require('os');
  const fs = require('fs');
  const home = os.homedir();
  const platform = os.platform();
  const globalDbPath = platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    : platform === 'linux'
      ? path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
      : path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(globalDbPath)) {
    console.log('   SKIP: global state.vscdb not found (not on this machine or Cursor not used)');
  } else {
    try {
      const {execFileSync} = require('child_process');
      execFileSync('sqlite3', ['-json', globalDbPath, 'SELECT 1 LIMIT 1'], {encoding: 'utf-8', maxBuffer: 1024 * 1024});
      console.log('   OK: sqlite3 CLI can query global DB');
    } catch (e) {
      console.log('   FAIL: sqlite3 CLI failed:', e.message || e);
      process.exit(1);
    }
  }

  console.log('\n=== 2. Index first 5 workspaces (fast) ===');
  const docs = await extractDocumentsForSearch(extensionPath, (msg) => console.log('   ', msg), {maxWorkspaces: 5});
  console.log('   Indexed', docs.length, 'conversation(s) from first 5 workspaces');

  if (docs.length > 0) {
    console.log('\n=== 3. Load full chat for first result ===');
    const first = docs[0];
    const composerMatch = first.id.match(/::composer::(.+)$/);
    const composerId = composerMatch ? composerMatch[1] : undefined;
    const messages = await getChatContentFromWorkspaceStorage(extensionPath, first.workspaceHash, first.tabIndex, composerId);
    console.log('   Doc:', first.title?.slice(0, 60));
    console.log('   Messages loaded:', messages.length, '(expected', first.messageCount + ')');
    if (messages.length > 0) {
      console.log('   First message:', messages[0].role, '-', messages[0].content?.slice(0, 50) + '...');
    }
  }

  console.log('\n=== Done. CLI solution is working. ===');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
