const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ToolCatalog } = require('../src/toolCatalog.js');
const { SlowManifestClient } = require('../src/manifestClient.js');

function tmpConfig() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-')), 'config.json');
}

// This test is slow: it goes through the real SlowManifestClient (~250ms per
// register call). It asserts the real duplicate-detection behavior, which
// depends on the config write actually happening.
test('rejects a duplicate tool registration', () => {
  const catalog = new ToolCatalog(tmpConfig(), new SlowManifestClient());
  catalog.register('linter');
  assert.throws(() => catalog.register('linter'), /duplicate/);
});
