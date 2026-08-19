import { expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStateConfig } from '../src/appliance/config.ts';
import { ApplianceError } from '../src/appliance/errors.ts';
import { createJob, readJob, updateJob } from '../src/appliance/jobs.ts';
import {
  provenancePath,
  writeProvenance,
} from '../src/appliance/provenance.ts';
import type {
  JobRecord,
  LoadedApplianceStateConfig,
} from '../src/appliance/types.ts';
import {
  FIXTURE_LIVE_SCOPE,
  liveJobRequest,
} from './appliance-job-fixtures.ts';

// provenancePath is pure structural path math: it must accept a state-only
// loaded config (no bundle field) and never look at bundle metadata.
test('provenancePath needs only structural state', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appliance-prov-')));
  const loaded: LoadedApplianceStateConfig = {
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
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
  expect(provenancePath(loaded, 'job-1')).toBe(
    join(root, 'state/provenance/job-1.json'),
  );
});

// The real structural loader with INVALID bundle metadata on disk still
// resolves provenance paths: recovery reads never touch the bundle.
test('provenancePath works through loadStateConfig with invalid bundle metadata', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appliance-prov-')));
  for (const dir of ['evals/results', 'credentials/blessed']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, 'credentials/blessed/metadata.json'), 'not json');
  const configPath = join(root, 'appliance.json');
  writeFileSync(
    configPath,
    JSON.stringify({
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
    }),
  );
  const loaded = loadStateConfig(configPath);
  expect(provenancePath(loaded, 'job-77')).toBe(
    join(root, 'state/provenance/job-77.json'),
  );
});

// --- live provenance is job-authoritative (F13 Task 5) ----------------------
// Job evidence is committed first; provenance is then DERIVED from the record
// this function rereads for itself. The caller names a job and supplies the
// tool-versions material, which lives nowhere else — no scope, no container
// evidence, no refs, no bundle, and no argv can be handed in at all.

const REFS = {
  superpowers_requested_ref: 'main',
  superpowers_resolved_sha: 's'.repeat(40),
  evals_ref: 'main',
  evals_resolved_sha: 'e'.repeat(40),
  gauntlet_ref: 'main',
  gauntlet_built_sha: 'g'.repeat(40),
};

const EVIDENCE = {
  name: 'quorum-appliance',
  id: 'c'.repeat(64),
  image_id: 'sha256:img-1',
  mount_signature: 'f'.repeat(64),
};

function stateFixture(): LoadedApplianceStateConfig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appliance-prov-')));
  for (const dir of ['evals/results', 'state/jobs', 'state/provenance']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
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
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
}

function jobWithCommittedEvidence(loaded: LoadedApplianceStateConfig) {
  const created = createJob(loaded, liveJobRequest('run'));
  return updateJob(loaded, created.job_id, (current) => ({
    ...current,
    refs: REFS,
    credential_bundle: { name: 'blessed', bundle_id: 'blessed-a' },
    container: EVIDENCE,
  }));
}

test('writeProvenance derives refs, bundle, evidence, and scope from the job', () => {
  const loaded = stateFixture();
  const job = jobWithCommittedEvidence(loaded);

  const path = writeProvenance(loaded, job.job_id, {
    path: '/state/jobs/x/evals-tool-versions.txt',
    text: 'bun 1.3.13\n',
  });

  expect(path).toBe(provenancePath(loaded, job.job_id));
  const record = JSON.parse(readFileSync(path, 'utf8'));
  expect(record.job_id).toBe(job.job_id);
  expect(record.refs).toEqual(REFS);
  expect(record.credential_bundle).toEqual({
    name: 'blessed',
    bundle_id: 'blessed-a',
  });
  expect(record.container).toEqual({
    ...EVIDENCE,
    code_mounts_read_only: false,
  });
  expect(record.credential_scope).toEqual(FIXTURE_LIVE_SCOPE);
  expect(record.command_argv).toEqual(job.command.argv);
  expect(record.requester).toEqual(job.requester);
  expect(record.tool_versions_text).toBe('bun 1.3.13\n');
  // Never a path into the credential namespace.
  expect(readFileSync(path, 'utf8')).not.toContain('credentials-scoped');
});

// Evidence is refused on the strength of what is ON DISK. A caller holding a
// complete record cannot make up for a job that never committed one.
test('writeProvenance refuses a job whose evidence is missing on disk', () => {
  const loaded = stateFixture();
  const missing: readonly {
    readonly what: string;
    readonly clear: (job: JobRecord) => JobRecord;
  }[] = [
    { what: 'refs', clear: (job) => ({ ...job, refs: null }) },
    {
      what: 'credential bundle',
      clear: (job) => ({ ...job, credential_bundle: null }),
    },
    {
      what: 'container evidence',
      clear: (job) => ({ ...job, container: null }),
    },
  ];

  for (const entry of missing) {
    const job = jobWithCommittedEvidence(loaded);
    updateJob(loaded, job.job_id, entry.clear);
    let caught: unknown = null;
    try {
      writeProvenance(loaded, job.job_id, { path: null, text: 'bun\n' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
    expect((caught as ApplianceError).message).toContain(entry.what);
  }

  // A job that has committed nothing at all.
  const created = createJob(loaded, liveJobRequest('run'));
  let caught: unknown = null;
  try {
    writeProvenance(loaded, created.job_id, { path: null, text: 'bun\n' });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApplianceError);
});

// The durable fields come off the job as it stands on disk at write time. A
// caller that still holds an earlier copy of the record — the exact shape a
// long-running worker accumulates — contributes none of it.
test('writeProvenance derives from disk, never from a caller-held record', () => {
  const loaded = stateFixture();
  const stale = jobWithCommittedEvidence(loaded);

  const currentEvidence = {
    ...EVIDENCE,
    id: 'd'.repeat(64),
    image_id: 'sha256:img-2',
  };
  const currentRefs = {
    ...REFS,
    superpowers_resolved_sha: 't'.repeat(40),
  };
  updateJob(loaded, stale.job_id, (current) => ({
    ...current,
    refs: currentRefs,
    credential_bundle: { name: 'blessed', bundle_id: 'blessed-b' },
    container: currentEvidence,
  }));

  const record = JSON.parse(
    readFileSync(
      writeProvenance(loaded, stale.job_id, { path: null, text: 'bun\n' }),
      'utf8',
    ),
  );

  const onDisk = readJob(loaded, stale.job_id);
  expect(record.container).toEqual({
    ...onDisk.container,
    code_mounts_read_only: false,
  });
  expect(record.refs).toEqual(onDisk.refs);
  expect(record.credential_bundle).toEqual(onDisk.credential_bundle);
  // None of what the caller still holds survived into the file.
  expect(record.container.id).not.toBe(stale.container?.id);
  expect(record.refs.superpowers_resolved_sha).not.toBe(
    stale.refs?.superpowers_resolved_sha,
  );
  expect(record.credential_bundle.bundle_id).not.toBe(
    stale.credential_bundle?.bundle_id,
  );
});

test('writeProvenance re-derives the same record on a healing retry', () => {
  const loaded = stateFixture();
  const job = jobWithCommittedEvidence(loaded);
  const toolVersions = { path: null, text: 'bun 1.3.13\n' };

  const first = JSON.parse(
    readFileSync(writeProvenance(loaded, job.job_id, toolVersions), 'utf8'),
  );
  const second = JSON.parse(
    readFileSync(writeProvenance(loaded, job.job_id, toolVersions), 'utf8'),
  );

  expect(second.container).toEqual(first.container);
  expect(second.credential_scope).toEqual(first.credential_scope);
  expect(second.refs).toEqual(first.refs);
  // The job itself is untouched by either write.
  expect(readJob(loaded, job.job_id).credential_scope).toEqual(
    FIXTURE_LIVE_SCOPE,
  );
});
