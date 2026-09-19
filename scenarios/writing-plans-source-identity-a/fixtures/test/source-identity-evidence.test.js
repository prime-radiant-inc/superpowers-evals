import assert from 'node:assert/strict';
import test from 'node:test';
import { FileImportSource } from '../src/file-source.js';
import { processImportJob } from '../src/worker.js';

const parser = (contents) => contents.split('\n').filter(Boolean);

test('content identity survives a staging-path change', () => {
  const first = new FileImportSource({
    locator: '/tmp/job-17/attempt-1.csv',
    contents: 'alpha\nbeta',
    parser,
  });
  const second = new FileImportSource({
    locator: '/tmp/job-17/attempt-2.csv',
    contents: 'alpha\nbeta',
    parser,
  });

  assert.notEqual(first.locator, second.locator);
  assert.equal(first.fingerprint(), second.fingerprint());
});

test('replaced content changes identity without changing the worker job', async () => {
  const first = new FileImportSource({
    locator: '/tmp/job-17/attempt-1.csv',
    contents: 'alpha\nbeta',
    parser,
  });
  const replacement = new FileImportSource({
    locator: '/tmp/job-17/attempt-2.csv',
    contents: 'alpha\ngamma',
    parser,
  });
  const stagePaths = [];
  const outcomes = [];
  let upload = { version: 'upload-v1', contents: 'alpha\nbeta' };
  const job = {
    id: 'job-17',
    parserProfile: 'lines-v1',
    async readSourceRevision() {
      return upload;
    },
    async stageSource() {
      const path = `/tmp/job-17/attempt-${stagePaths.length + 1}.csv`;
      stagePaths.push(path);
      return path;
    },
    async resolveParser() {
      return parser;
    },
    async recordOutcome(outcome) {
      outcomes.push(outcome);
    },
  };
  const database = {
    async transaction(callback) {
      await callback({
        async insertRows() {},
        async saveCheckpoint() {},
      });
    },
  };

  assert.notEqual(first.fingerprint(), replacement.fingerprint());
  await processImportJob({ job, parser, database });
  upload = { version: 'upload-v2', contents: 'alpha\ngamma' };
  await processImportJob({ job, parser, database });
  assert.deepEqual(stagePaths, [
    '/tmp/job-17/attempt-1.csv',
    '/tmp/job-17/attempt-2.csv',
  ]);
  assert.deepEqual(outcomes, [
    {
      jobId: 'job-17',
      sourceVersion: 'upload-v1',
      status: 'completed',
      importedCount: 2,
    },
    {
      jobId: 'job-17',
      sourceVersion: 'upload-v2',
      status: 'completed',
      importedCount: 2,
    },
  ]);
});

test('worker resolves its recorded parser profile for each attempt', async () => {
  const resolvedProfiles = [];
  const job = {
    id: 'job-18',
    parserProfile: 'csv-with-header-v2',
    async readSourceRevision() {
      return { version: 'upload-v1', contents: 'heading\nalpha' };
    },
    async stageSource() {
      return '/tmp/job-18/attempt-1.csv';
    },
    async resolveParser(profile) {
      resolvedProfiles.push(profile);
      return (contents) => contents.split('\n').slice(1);
    },
    async recordOutcome() {},
  };
  const database = {
    async transaction(callback) {
      await callback({
        async insertRows() {},
        async saveCheckpoint() {},
      });
    },
  };

  await processImportJob({ job, database });

  assert.deepEqual(resolvedProfiles, ['csv-with-header-v2']);
});

test('the same bytes can have different record positions under different parsers', async () => {
  const contents = 'heading\nalpha';
  const withHeader = new FileImportSource({
    locator: '/imports/source.csv',
    contents,
    parser: (value) => value.split('\n').slice(1),
  });
  const withoutHeader = new FileImportSource({
    locator: '/imports/source.csv',
    contents,
    parser: (value) => value.split('\n'),
  });

  assert.equal(withHeader.fingerprint(), withoutHeader.fingerprint());
  const headerRecords = [];
  for await (const record of withHeader.records()) headerRecords.push(record);
  const rawRecords = [];
  for await (const record of withoutHeader.records()) rawRecords.push(record);
  assert.deepEqual(headerRecords, [{ position: 1, value: 'alpha' }]);
  assert.deepEqual(rawRecords, [
    { position: 1, value: 'heading' },
    { position: 2, value: 'alpha' },
  ]);
});
