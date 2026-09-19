import { FileImportSource } from './file-source.js';
import { runImport } from './import-service.js';
import { ImportStore } from './import-store.js';

export async function processImportJob({ job, database }) {
  const upload = await job.readSourceRevision();
  const stagePath = await job.stageSource(upload.contents);
  const parser = await job.resolveParser(job.parserProfile);
  const importedCount = await runImport({
    source: new FileImportSource({
      locator: stagePath,
      contents: upload.contents,
      parser,
    }),
    store: new ImportStore(database),
  });

  await job.recordOutcome({
    jobId: job.id,
    sourceVersion: upload.version,
    status: 'completed',
    importedCount,
  });
  return { status: 'completed', importedCount };
}
