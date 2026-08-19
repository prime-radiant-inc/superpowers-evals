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
import type { LoadedApplianceStateConfig } from '../src/appliance/types.ts';
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
// Job evidence is committed first; provenance is then DERIVED from the reread
// record. The caller supplies no scope, no container evidence, no refs and no
// bundle — only the tool-versions material, which lives nowhere else.

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

  const path = writeProvenance(loaded, job, {
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

test('writeProvenance refuses a job that has not committed its evidence', () => {
  const loaded = stateFixture();
  const created = createJob(loaded, liveJobRequest('run'));
  const missing: readonly (keyof ReturnType<
    typeof jobWithCommittedEvidence
  >)[] = ['refs', 'credential_bundle', 'container'];

  for (const field of missing) {
    const job = { ...jobWithCommittedEvidence(loaded), [field]: null };
    let caught: unknown = null;
    try {
      writeProvenance(loaded, job, { path: null, text: 'bun\n' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
  }

  let caught: unknown = null;
  try {
    writeProvenance(loaded, created, { path: null, text: 'bun\n' });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApplianceError);
});

test('writeProvenance re-derives the same record on a healing retry', () => {
  const loaded = stateFixture();
  const job = jobWithCommittedEvidence(loaded);
  const toolVersions = { path: null, text: 'bun 1.3.13\n' };

  const first = JSON.parse(
    readFileSync(writeProvenance(loaded, job, toolVersions), 'utf8'),
  );
  const second = JSON.parse(
    readFileSync(
      writeProvenance(loaded, readJob(loaded, job.job_id), toolVersions),
      'utf8',
    ),
  );

  expect(second.container).toEqual(first.container);
  expect(second.credential_scope).toEqual(first.credential_scope);
  expect(second.refs).toEqual(first.refs);
});
