'use strict';
const path = require('path');
const extensionPath = path.resolve(__dirname, '..');

async function main() {
  const {extractDocumentsForSearch} = require('../out/chatExtractor.js');
  const start = Date.now();
  const docs = await extractDocumentsForSearch(extensionPath, (msg) => console.log(' ', msg));
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone: ${docs.length} conversations indexed in ${elapsed}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
