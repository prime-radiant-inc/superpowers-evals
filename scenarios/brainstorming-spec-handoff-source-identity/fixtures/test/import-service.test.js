import assert from 'node:assert/strict';
import test from 'node:test';
import { runImport } from '../src/import-service.js';

test('imports every source record through the shared store', async () => {
  const commits = [];
  const source = {
    async *records() {
      yield { position: 1, value: 'alpha' };
      yield { position: 2, value: 'beta' };
    },
  };
  const store = {
    async commitBatch(batch) {
      commits.push(batch);
    },
  };

  const importedCount = await runImport({ source, store, batchSize: 1 });

  assert.deepEqual(commits, [
    { rows: [{ position: 1, value: 'alpha' }], checkpoint: null },
    { rows: [{ position: 2, value: 'beta' }], checkpoint: null },
  ]);
  assert.equal(importedCount, 2);
});
