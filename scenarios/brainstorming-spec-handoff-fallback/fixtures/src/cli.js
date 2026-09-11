import { FileImportSource } from './file-source.js';
import { runImport } from './import-service.js';
import { ImportStore } from './import-store.js';
import { ImportControl } from './import-control.js';

export async function importCommand({ path, contents, parser, database }) {
  const importedCount = await runImport({
    source: new FileImportSource({ path, contents, parser }),
    store: new ImportStore(database),
  });

  return `Imported ${importedCount} rows`;
}

export async function cancelImportCommand({ importId, requestedBy, database }) {
  const control = new ImportControl(database);
  const result = await control.requestCancellation(importId, requestedBy);
  return result.accepted ? 'Cancellation requested' : `Import is ${result.status}`;
}
