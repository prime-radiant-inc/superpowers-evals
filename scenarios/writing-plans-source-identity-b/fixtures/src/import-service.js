const DEFAULT_BATCH_SIZE = 100;

export async function runImport({ source, store, batchSize = DEFAULT_BATCH_SIZE }) {
  let rows = [];
  let importedCount = 0;

  for await (const record of source.records()) {
    rows.push(record);
    importedCount += 1;
    if (rows.length === batchSize) {
      await store.commitBatch({ rows, checkpoint: null });
      rows = [];
    }
  }

  if (rows.length > 0) {
    await store.commitBatch({ rows, checkpoint: null });
  }

  return importedCount;
}
