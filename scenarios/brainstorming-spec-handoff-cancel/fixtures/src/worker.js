import { FileImportSource } from './file-source.js';
import { runImport } from './import-service.js';
import { ImportStore } from './import-store.js';

export async function processImportJob({ job, parser, database }) {
  const importedCount = await runImport({
    source: new FileImportSource({
      path: job.sourcePath,
      contents: job.sourceContents,
      parser,
    }),
    store: new ImportStore(database),
  });

  await job.recordOutcome({ status: 'completed', importedCount });
  return { status: 'completed', importedCount };
}
