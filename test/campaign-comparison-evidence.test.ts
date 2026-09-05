import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  publishExecution,
  readPublishedArtifactBytes,
} from '../src/campaign/attempt-publish.ts';
import {
  readAttemptEvidence,
  readBlockValidity,
} from '../src/campaign/report-evidence.ts';
import {
  jcsCanonicalize,
  sha256Hex,
} from '../src/contracts/campaign/digest.ts';
import { buildRunEconomics } from '../src/economics.ts';
import { writeAttemptManifest } from '../src/runner/manifest.ts';
import {
  blockActivation,
  fixtureTime,
  twoArmExperiment,
} from './fixtures/core-comparison/factory.ts';
import { mixedComparisonFixture } from './fixtures/core-comparison/report-fixture.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function publication(
  patch: Record<string, unknown> = {},
  usage: unknown = undefined,
) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'comparison-evidence-')),
  );
  roots.push(root);
  const intent = blockActivation(twoArmExperiment()).attempts[0]!;
  intent.output_root = join(root, 'attempt');
  const resultsRoot = join(root, 'custom-artifacts');
  mkdirSync(resultsRoot);
  const runDir = join(intent.output_root, 'staging', 'runner-id');
  mkdirSync(runDir, { recursive: true });
  const role = {
    est_cost_usd: 2,
    has_unpriced_model: false,
    tokens: { total: 42 },
    duration_ms: 999999,
  };
  const verdict = {
    schema: 1,
    campaign: intent.identity,
    final: 'pass',
    final_reason: 'fixture',
    gauntlet: {
      status: 'pass',
      summary: 'observed',
      reasoning: 'fixture',
      run_id: 'g',
      process_exit: { code: null, signal: 'SIGSEGV' },
    },
    checks: [],
    error: null,
    started_at: fixtureTime(0),
    finished_at: fixtureTime(10),
    economics: { coding_agent: role, gauntlet: { ...role, est_cost_usd: 0.2 } },
    ...patch,
  };
  writeFileSync(join(runDir, 'verdict.json'), JSON.stringify(verdict));
  if (usage !== undefined)
    writeFileSync(
      join(runDir, 'coding-agent-token-usage.json'),
      JSON.stringify(usage),
    );
  mkdirSync(join(runDir, 'coding-agent-workdir'));
  writeFileSync(
    join(runDir, 'coding-agent-workdir', 'binary.bin'),
    Buffer.from([0xff, 0x80, 0x00, 0x42]),
  );
  writeAttemptManifest(runDir, intent.identity);
  const published = publishExecution({
    bound: { intent, container_id: 'a'.repeat(64) },
    stopped: {
      execution_attempt_id: intent.identity.execution_attempt_id,
      container_id: 'a'.repeat(64),
      proof: 'inspected_stopped',
      observed_at: fixtureTime(11),
    },
    resultsRoot,
  });
  return {
    root,
    resultsRoot,
    expectedIdentity: intent.identity,
    artifacts: published.artifacts,
    runDir: join(resultsRoot, published.runId),
  };
}
test('real runner manifest and publisher round trip binary artifacts under a custom root', () => {
  const p = publication();
  const e = readAttemptEvidence(p);
  expect(e.publication_valid).toBe(true);
  expect(e.wall_seconds).toBe(10);
  expect(e.subject_cost_usd).toBe(2);
  expect(e.grader_cost_usd).toBe(0.2);
  expect(e.gauntlet?.process_exit).toEqual({ code: null, signal: 'SIGSEGV' });
  for (const ref of p.artifacts)
    expect(readPublishedArtifactBytes(p.resultsRoot, ref)).toEqual(
      readFileSync(join(p.resultsRoot, ref.path)),
    );
});
test('invalid optional role price and run duration leave independently valid grader fields', () => {
  const p = publication({
    finished_at: 'bad',
    economics: {
      coding_agent: {
        est_cost_usd: -3,
        has_unpriced_model: false,
        tokens: { total: 12 },
      },
      gauntlet: {
        est_cost_usd: 0.7,
        has_unpriced_model: false,
        tokens: { total: 4 },
      },
    },
  });
  const e = readAttemptEvidence(p);
  expect(e.publication_valid).toBe(true);
  expect(e.subject_cost_usd).toBeNull();
  expect(e.subject_tokens).toBe(12);
  expect(e.grader_cost_usd).toBe(0.7);
  expect(e.wall_seconds).toBeNull();
  expect(e.observed_outcome).toBe('pass');
});
test('corrupt shared verdict bytes lose every verdict value; independent frozen usage survives', () => {
  const p = publication(
    {},
    { est_cost_usd: 3, unpriced_models: [], total_tokens: 55 },
  );
  writeFileSync(join(p.runDir, 'verdict.json'), 'corrupted');
  const e = readAttemptEvidence(p);
  expect(e.observed_outcome).toBeNull();
  expect(e.gauntlet).toBeNull();
  expect(e.wall_seconds).toBeNull();
  expect(e.grader_cost_usd).toBeNull();
  expect(e.subject_cost_usd).toBe(3);
  expect(e.subject_tokens).toBe(55);
});
test('manifest, identity and reference-inventory failures invalidate the whole publication', () => {
  const p = publication();
  expect(
    readAttemptEvidence({
      ...p,
      expectedIdentity: {
        ...p.expectedIdentity,
        execution_attempt_id: 'other',
      },
    }).publication_valid,
  ).toBe(false);
  expect(
    readAttemptEvidence({ ...p, artifacts: p.artifacts.slice(1) })
      .publication_valid,
  ).toBe(false);
  const q = publication({
    campaign: { ...p.expectedIdentity, sample_id: 'foreign' },
  });
  expect(readAttemptEvidence(q).subject_cost_usd).toBeNull();
  writeFileSync(join(p.runDir, 'manifest.json'), '{}');
  expect(readAttemptEvidence(p).grader_cost_usd).toBeNull();
});
test('symlink and path tampering cannot authenticate artifact values', () => {
  const p = publication();
  const path = join(p.runDir, 'verdict.json');
  const body = readFileSync(path);
  writeFileSync(join(p.root, 'outside'), body);
  rmSync(path);
  symlinkSync(join(p.root, 'outside'), path);
  expect(readAttemptEvidence(p).observed_outcome).toBeNull();
  const refs = structuredClone(p.artifacts);
  refs[0]!.path = '../outside';
  expect(readAttemptEvidence({ ...p, artifacts: refs }).publication_valid).toBe(
    false,
  );
});
test('malformed process facts stay unknown without losing judgment or role costs', () => {
  const p = publication({
    gauntlet: {
      status: 'pass',
      summary: 's',
      reasoning: 'r',
      run_id: 'g',
      process_exit: { code: 0, signal: 'SIGSEGV' },
    },
  });
  const e = readAttemptEvidence(p);
  expect(e.gauntlet?.status).toBe('pass');
  expect(e.gauntlet?.process_exit).toBeUndefined();
  expect(e.subject_cost_usd).toBe(2);
});
test('real economics producer preserves known subtotal with an unpriced model in the same role', async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'comparison-economics-')),
  );
  roots.push(root);
  const usage = {
    total_input: 10,
    total_output: 10,
    total_cache_create: 0,
    total_cache_read: 0,
    total_tokens: 20,
    model: null,
    models: {
      priced: {
        total_input: 5,
        total_output: 5,
        total_cache_create: 0,
        total_cache_read: 0,
        total_tokens: 10,
        provider: 'fixture',
        est_cost_usd: 3,
      },
      unknown: {
        total_input: 5,
        total_output: 5,
        total_cache_create: 0,
        total_cache_read: 0,
        total_tokens: 10,
        provider: 'fixture',
        est_cost_usd: null,
      },
    },
    est_cost_usd: 3,
    unpriced_models: ['unknown'],
    approximations: [],
    pricing_as_of: '2026-09-04',
    duration_ms: 1000,
  };
  writeFileSync(
    join(root, 'coding-agent-token-usage.json'),
    JSON.stringify(usage),
  );
  const economics = await buildRunEconomics(root);
  const e = readAttemptEvidence(publication({ economics }, usage));
  expect(e.subject_cost_usd).toBe(3);
  expect(e.subject_cost_complete).toBe(false);
  expect(e.subject_tokens).toBe(20);
});
function validity() {
  const f = mixedComparisonFixture();
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'comparison-validity-')),
  );
  roots.push(root);
  const block = f.state.blocks.get('c1-r1')!;
  const receipt = {
    campaign_id: f.experiment.campaign_id,
    input_digest: f.experiment.input_digest,
    start_id: 'start',
    block_id: 'c1-r1',
    at: fixtureTime(8),
    verdict: 'valid',
    details: {
      exposures: [1, 2],
      contention: 'clean',
      intervals: [],
      telemetry: { lines: [], truncatedTail: false },
    },
  };
  const put = (value: unknown) => {
    const body = `${jcsCanonicalize(value)}\n`;
    writeFileSync(join(root, 'audit.json'), body);
    block.validity_receipt!.evidence_refs = [
      {
        path: 'audit.json',
        sha256: sha256Hex(body),
        bytes: Buffer.byteLength(body),
      },
    ];
  };
  put(receipt);
  return { campaignDir: root, state: f.state, block, receipt, put };
}
test('positive validity checks bytes, identity, claimed verdict and narrow shape', () => {
  const v = validity();
  expect(readBlockValidity(v).available).toBe(true);
  writeFileSync(join(v.campaignDir, 'audit.json'), '{}');
  expect(readBlockValidity(v).available).toBe(false);
  v.put({ ...v.receipt, start_id: 'other' });
  expect(readBlockValidity(v).available).toBe(false);
  v.put({ ...v.receipt, verdict: 'skew' });
  expect(readBlockValidity(v).available).toBe(false);
  v.put({
    ...v.receipt,
    details: {
      ...v.receipt.details,
      telemetry: { lines: [{ bogus: true }], truncatedTail: false },
    },
  });
  expect(readBlockValidity(v).available).toBe(false);
});

test('absence and malformed optional evidence fields carry explicit missingness', () => {
  const e = readAttemptEvidence(
    publication({
      gauntlet: null,
      checks: 'invalid',
      provenance: { harness_rev: 7 },
    }),
  );
  expect(e.missingness.map((m) => m.field)).toEqual(
    expect.arrayContaining(['gauntlet', 'checks', 'versions', 'subject_usage']),
  );
});
test('malformed optional usage price and duration do not invalidate independent usage counts', () => {
  const usage = {
    total_input: 1,
    total_output: 2,
    total_cache_create: 0,
    total_cache_read: 0,
    total_tokens: 3,
    model: 'm',
    models: {},
    est_cost_usd: -1,
    unpriced_models: [],
    approximations: [],
    pricing_as_of: null,
    duration_ms: -3,
  };
  const e = readAttemptEvidence(publication({}, usage));
  expect(e.subject_usage?.total_tokens).toBe(3);
  expect(e.subject_usage?.est_cost_usd).toBeNull();
  expect(e.subject_usage?.duration_ms).toBeNull();
});
