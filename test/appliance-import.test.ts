import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApplianceError,
  type ApplianceErrorCode,
} from '../src/appliance/errors.ts';
import { importBundle } from '../src/appliance/import.ts';
import { readJob } from '../src/appliance/jobs.ts';
import { acquireLock } from '../src/appliance/locks.ts';
import {
  ImportedProvenanceRecordSchema,
  type LoadedApplianceConfig,
} from '../src/appliance/types.ts';

function loaded(): LoadedApplianceConfig {
  const root = mkdtempSync(join(tmpdir(), 'appliance-import-'));
  mkdirSync(join(root, 'state/jobs'), { recursive: true });
  mkdirSync(join(root, 'state/locks'), { recursive: true });
  mkdirSync(join(root, 'state/provenance'), { recursive: true });
  mkdirSync(join(root, 'evals/results'), { recursive: true });
  return {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: join(root, 'evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: {
        name: 'blessed',
        path: join(root, 'credentials/blessed'),
      },
      container: {
        name: 'quorum-appliance',
        results_root: join(root, 'evals/results'),
      },
    },
    bundle: {
      bundle_id: 'blessed-2026-06-18-a',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: [],
      note: 'test',
    },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
}

const RUN_ID = 'demo-codex-codex_sub-linux-20260730T201515Z-a325';

function sha256(body: string): string {
  return Bun.SHA256.hash(Buffer.from(body), 'hex');
}

interface BundleOverrides {
  readonly extraFile?: { readonly path: string; readonly body: string };
  readonly corruptChecksum?: boolean;
  readonly revRecovery?: string;
}

function makeBundle(overrides: BundleOverrides = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  const runDir = join(dir, 'runs', RUN_ID);
  mkdirSync(runDir, { recursive: true });

  const verdictBody = JSON.stringify({ schema: 1, final: 'pass' });
  writeFileSync(join(runDir, 'verdict.json'), verdictBody);
  const files: Record<string, string> = {
    'verdict.json': overrides.corruptChecksum
      ? sha256('something else entirely')
      : sha256(verdictBody),
  };

  if (overrides.extraFile !== undefined) {
    const path = join(runDir, overrides.extraFile.path);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, overrides.extraFile.body);
    files[overrides.extraFile.path] = sha256(overrides.extraFile.body);
  }

  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      created_at: '2026-08-09T00:00:00.000Z',
      source_host: 'laptop',
      source_results_dir: '/Users/jesse/git/evals/results',
      entries: [
        {
          run_id: RUN_ID,
          source_path: `/Users/jesse/git/evals/results/cx-demo-rep1/${RUN_ID}`,
          scenario: 'demo-scenario',
          coding_agent: 'codex',
          credential: 'codex_sub',
          os: 'linux',
          started_at: '2026-07-30T20:15:15.000Z',
          finished_at: '2026-07-30T20:35:15.000Z',
          final: 'pass',
          harness_rev: 'abc123harness',
          rev_recovery: overrides.revRecovery ?? 'recovered',
          superpowers_sha: '3da65fb0da716305934940f0760376496defc4e7',
          superpowers_tree_sha: '0df4d01f92fd50730641366288d54ee59561a30c',
          inferred_superpowers_sha: null,
          files,
        },
      ],
      skipped: [],
    }),
  );
  return dir;
}

function expectCode(fn: () => void, code: ApplianceErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApplianceError);
    expect((error as ApplianceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ApplianceError ${code}`);
}

test('import lands the payload and writes an imported job record', () => {
  const cfg = loaded();
  const result = importBundle(cfg, { bundleDir: makeBundle() });

  expect(result.imported).toBe(1);
  expect(result.skipped).toBe(0);
  expect(
    existsSync(join(cfg.config.container.results_root, RUN_ID, 'verdict.json')),
  ).toBe(true);

  const job = readJob(cfg, RUN_ID);
  expect(job.kind).toBe('import');
  expect(job.status).toBe('done');
  expect(job.artifacts.run_id).toBe(RUN_ID);
  expect(job.result.exit_code).toBe(0);
  // An imported job must never claim refs or a blessed bundle it never had.
  expect(job.refs).toBeNull();
  expect(job.credential_bundle).toBeNull();
  expect(job.container).toBeNull();
  expect(job.origin?.kind).toBe('imported');
  expect(job.origin?.rev_recovery).toBe('recovered');
  expect(job.origin?.superpowers_sha).toBe(
    '3da65fb0da716305934940f0760376496defc4e7',
  );
  expect(job.origin?.source_host).toBe('laptop');
});

test('imported provenance is written next to the run and in the state dir', () => {
  const cfg = loaded();
  importBundle(cfg, { bundleDir: makeBundle() });
  const job = readJob(cfg, RUN_ID);

  const stateRecord = ImportedProvenanceRecordSchema.parse(
    JSON.parse(readFileSync(job.artifacts.provenance, 'utf8')),
  );
  expect(stateRecord.job_id).toBe(job.job_id);
  expect(stateRecord.origin.superpowers_sha).toBe(
    '3da65fb0da716305934940f0760376496defc4e7',
  );

  const beside = join(
    cfg.config.container.results_root,
    RUN_ID,
    'appliance-provenance.json',
  );
  expect(existsSync(beside)).toBe(true);
});

test('a checksum mismatch aborts before anything lands', () => {
  const cfg = loaded();
  expectCode(
    () =>
      importBundle(cfg, { bundleDir: makeBundle({ corruptChecksum: true }) }),
    'artifact_missing',
  );
  expect(existsSync(join(cfg.config.container.results_root, RUN_ID))).toBe(
    false,
  );
});

test('a credential-shaped path in the bundle is rejected outright', () => {
  const cfg = loaded();
  expectCode(
    () =>
      importBundle(cfg, {
        bundleDir: makeBundle({
          extraFile: { path: 'raw-sessions/auth.json', body: '{"t":"secret"}' },
        }),
      }),
    'config_invalid',
  );
  expect(existsSync(join(cfg.config.container.results_root, RUN_ID))).toBe(
    false,
  );
});

test('importing the same bundle twice lands one copy', () => {
  const cfg = loaded();
  const bundle = makeBundle();
  importBundle(cfg, { bundleDir: bundle });
  const second = importBundle(cfg, { bundleDir: bundle });

  expect(second.imported).toBe(0);
  expect(second.skipped).toBe(1);
  // One job record, not two.
  const job = readJob(cfg, RUN_ID);
  expect(job.artifacts.run_id).toBe(RUN_ID);
});

test('a conflicting destination is rejected: landed run untouched, payload quarantined', () => {
  const cfg = loaded();
  const bundle = makeBundle();
  importBundle(cfg, { bundleDir: bundle });
  const landed = join(
    cfg.config.container.results_root,
    RUN_ID,
    'verdict.json',
  );
  writeFileSync(landed, 'STALE');

  const second = importBundle(cfg, { bundleDir: bundle });
  expect(second.imported).toBe(0);
  expect(second.failed).toBe(1);
  expect(second.failures[0]?.code).toBe('import_conflict');
  // The landed evidence is byte-for-byte what it was:
  expect(readFileSync(landed, 'utf8')).toBe('STALE');
  // The incoming payload was quarantined intact, not deleted:
  const qroot = join(cfg.config.root, 'state', 'quarantine');
  const qdirs = readdirSync(qroot);
  const qname = qdirs.find((d) => d.includes(RUN_ID));
  expect(qname).toBeDefined();
  expect(
    readFileSync(join(qroot, qname as string, 'verdict.json'), 'utf8'),
  ).not.toBe('STALE');
});

test('a pre-existing identical run dir with no job record is record-healed, not overwritten', () => {
  const cfg = loaded();
  const bundle = makeBundle();
  // A run dir that predates appliance records (e.g. committed locally):
  const destRun = join(cfg.config.container.results_root, RUN_ID);
  mkdirSync(destRun, { recursive: true });
  // Byte-identical to makeBundle's payload (same body string as makeBundle uses):
  writeFileSync(
    join(destRun, 'verdict.json'),
    JSON.stringify({ schema: 1, final: 'pass' }),
  );

  const result = importBundle(cfg, { bundleDir: bundle });
  expect(result.imported).toBe(0);
  expect(result.healed).toBe(1);
  expect(readJob(cfg, RUN_ID).artifacts.run_id).toBe(RUN_ID);
});

test('a manifest run_id with path traversal is rejected before anything lands', () => {
  const cfg = loaded();
  const dir = makeBundle();
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.entries[0].run_id = '../../evil';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  expectCode(() => importBundle(cfg, { bundleDir: dir }), 'config_invalid');
  expect(existsSync(join(cfg.config.container.results_root, 'evil'))).toBe(
    false,
  );
});

test('a failing verdict imports with a non-zero exit code', () => {
  const cfg = loaded();
  const dir = makeBundle();
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.entries[0].final = 'fail';
  writeFileSync(manifestPath, JSON.stringify(manifest));

  importBundle(cfg, { bundleDir: dir });
  expect(readJob(cfg, RUN_ID).result.exit_code).toBe(1);
});

test('import refuses while a live job holds run.lock', () => {
  const cfg = loaded();
  const held = acquireLock({
    loaded: cfg,
    name: 'run.lock',
    jobId: 'job-live',
    command: 'run-all',
  });

  try {
    expectCode(
      () => importBundle(cfg, { bundleDir: makeBundle() }),
      'lock_busy',
    );
    expect(existsSync(join(cfg.config.container.results_root, RUN_ID))).toBe(
      false,
    );
  } finally {
    held.release();
  }
});

test('import releases run.lock when a bundle is rejected', () => {
  const cfg = loaded();
  expectCode(
    () =>
      importBundle(cfg, { bundleDir: makeBundle({ corruptChecksum: true }) }),
    'artifact_missing',
  );

  // A rejected import must not strand the lock; the next one has to work.
  const result = importBundle(cfg, { bundleDir: makeBundle() });
  expect(result.imported).toBe(1);
});

test('a malformed manifest is a config error, not a crash', () => {
  const cfg = loaded();
  const dir = mkdtempSync(join(tmpdir(), 'bundle-bad-'));
  writeFileSync(join(dir, 'manifest.json'), '{"schema_version": 99}');
  expectCode(() => importBundle(cfg, { bundleDir: dir }), 'config_invalid');
});
