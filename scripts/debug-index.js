'use strict';
const path = require('path');
const extensionPath = path.resolve(__dirname, '..');

async function main() {
  const {extractDocumentsForSearch, getChatContentFromWorkspaceStorage} = require('../out/chatExtractor.js');
  const docs = await extractDocumentsForSearch(extensionPath, (msg) => console.log(' ', msg));
  console.log('\nIndexed', docs.length, 'documents\n');

  const ontologyDocs = docs.filter(d =>
    d.workspaceName?.toLowerCase().includes('ontology') ||
    d.title?.toLowerCase().includes('manuscripts') ||
    d.title?.toLowerCase().includes('protege') ||
    d.title?.toLowerCase().includes('hebrew')
  );
  console.log('Ontology-related docs:', ontologyDocs.length);

  for (const doc of ontologyDocs) {
    console.log('\n--- Doc:', doc.id);
    console.log('    title:', doc.title?.slice(0, 100));
    console.log('    workspace:', doc.workspaceName, '| hash:', doc.workspaceHash, '| tabIndex:', doc.tabIndex);
    console.log('    messageCount (from index):', doc.messageCount);

    const composerMatch = doc.id.match(/::composer::(.+)$/);
    const composerId = composerMatch ? composerMatch[1] : undefined;
    const messages = await getChatContentFromWorkspaceStorage(extensionPath, doc.workspaceHash, doc.tabIndex, composerId);
    console.log('    getChatContentFromWorkspaceStorage returned:', messages.length, 'messages');
    if (messages.length > 0) {
      console.log('    First 5 msgs:');
      for (let i = 0; i < Math.min(5, messages.length); i++) {
        console.log('      [' + messages[i].role + ']', messages[i].content?.slice(0, 80));
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
