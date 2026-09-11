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
  measureAttempt,
  readAttemptEvidence,
  readBlockValidity,
} from '../src/campaign/report-evidence.ts';
import {
  jcsCanonicalize,
  sha256Hex,
} from '../src/contracts/campaign/digest.ts';
import { buildRunEconomics } from '../src/economics.ts';
import { mergeEstimates } from '../src/obol/index.ts';
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
  files: Record<string, unknown> = {},
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
  for (const [path, body] of Object.entries(files)) {
    const dest = join(runDir, path);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, JSON.stringify(body));
  }
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
test.each([
  false,
  true,
])('assessment request accounting complete=%s survives publication into campaign costs', (complete) => {
  const p = publication({
    economics: {
      coding_agent: {
        est_cost_usd: 2,
        has_unpriced_model: false,
        tokens: { total: 42 },
      },
      gauntlet: {
        est_cost_usd: 0.2,
        has_unpriced_model: false,
        tokens: { total: 20 },
        obol: { unpriced_models: [] },
      },
      assessment_accounting: {
        logicalResponses: 4,
        physicalAttempts: complete ? 4 : 5,
        unknownUsageAttemptIds: complete ? [] : ['005'],
        complete,
        error: null,
      },
      partial: !complete,
      total_est_cost_usd: complete ? 2.2 : null,
    },
  });
  const e = readAttemptEvidence(p);
  expect(e.publication_valid).toBe(true);
  expect(e.observed_outcome).toBe('pass');
  expect(e.subject_cost_usd).toBe(2);
  expect(e.subject_cost_complete).toBe(true);
  expect(e.grader_cost_usd).toBe(0.2);
  expect(e.grader_cost_complete).toBe(complete);
  expect(e.missingness.some((m) => m.field === 'grader_tokens')).toBe(
    !complete,
  );
  expect(e.missingness.some((item) => item.field === 'grader_cost_usd')).toBe(
    !complete,
  );
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
test('manifest and identity failures invalidate the whole publication', () => {
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
  ).toBe(true);
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
    true,
  );
  expect(
    readAttemptEvidence({ ...p, artifacts: refs }).observed_outcome,
  ).toBeNull();
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
  const captured = mergeEstimates([
    {
      total_usd: 3,
      pricing_as_of: '2026-09-04',
      unpriced_models: ['unknown'],
      approximations: [],
      tokens: { input: 10, output: 10, cache_write: 0, cache_read: 0 },
      per_model: Object.entries(usage.models).map(([model, m]) => ({
        model,
        provider: m.provider,
        subtotal_usd: m.est_cost_usd ?? 0,
        tokens: {
          input: m.total_input,
          output: m.total_output,
          cache_write: 0,
          cache_read: 0,
        },
      })),
    },
  ]);
  expect(captured?.est_cost_usd).toBe(3);
  expect(captured?.unpriced_models).toEqual(['unknown']);
  writeFileSync(
    join(root, 'coding-agent-token-usage.json'),
    JSON.stringify(captured),
  );
  const economics = await buildRunEconomics(root);
  const e = readAttemptEvidence(publication({ economics }, captured));
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

test('non-manifest reference path, digest and byte-count failures preserve independent frozen artifacts', () => {
  for (const field of ['path', 'sha256', 'bytes', 'missing'] as const) {
    const p = publication(
      {},
      { est_cost_usd: 3, unpriced_models: [], total_tokens: 55 },
    );
    const refs = structuredClone(p.artifacts);
    const index = refs.findIndex((r) => r.path.endsWith('/verdict.json'));
    if (field === 'path') refs[index]!.path = '../untrusted/verdict.json';
    if (field === 'sha256') refs[index]!.sha256 = 'b'.repeat(64);
    if (field === 'bytes') refs[index]!.bytes++;
    if (field === 'missing') refs.splice(index, 1);
    const e = readAttemptEvidence({ ...p, artifacts: refs });
    expect(e.publication_valid).toBe(true);
    expect(e.subject_cost_usd).toBe(3);
    expect(e.grader_cost_usd).toBeNull();
    expect(e.observed_outcome).toBeNull();
  }
});

test('conversation records require their own authenticated bytes and survive assessment timeout', () => {
  const conversation = {
    status: 'completed' as const,
    endpoint: 'delivery' as const,
    reason: 'delivered',
    timestamp: fixtureTime(5),
    evidence: { path: 'visible.json', quote: 'done' },
  };
  const p = publication({ final: 'indeterminate', gauntlet: null }, undefined, {
    'conversation.json': conversation,
    'visible.json': { text: 'done' },
  });
  expect(readAttemptEvidence(p).conversation).toEqual(conversation);
  writeFileSync(join(p.runDir, 'conversation.json'), '{}');
  expect(readAttemptEvidence(p).conversation).toBeNull();
  expect(readAttemptEvidence(p).subject_cost_usd).toBe(2);
});

function conversationPublication(
  completed: boolean,
  completionPatch: Record<string, unknown> = {},
  resultPatch: Record<string, unknown> = {},
  additionalFiles: Record<string, unknown> = {},
) {
  const run = 'review_20260904T000000Z_abcd';
  const out = `assessment/${run}`;
  const checks = [
    {
      phase: 'post',
      check: 'file-exists',
      args: ['answer'],
      negated: false,
      passed: true,
      checker_status: 'completed',
      detail: null,
    },
  ];
  const result = {
    runId: run,
    scenario: 'review',
    status: 'pass',
    summary: 'done',
    reasoning: 'complete report',
    criteria: [
      {
        criterion: 'Trace claim',
        verdict: 'pass',
        evidence: 'native invocation',
      },
      {
        criterion: 'Grounded delivery',
        verdict: 'pass',
        evidence: 'supplied source and delivered review',
      },
    ],
  };
  Object.assign(result, resultPatch);
  const role = {
    out_dir: out,
    model: 'grader',
    started_at: fixtureTime(0),
    finished_at: fixtureTime(9),
    process_exit: { code: 0, signal: null },
    stop_cause: null,
  };
  const files = {
    'conversation.json': {
      status: 'completed',
      endpoint: 'delivery',
      reason: 'done',
      timestamp: fixtureTime(5),
      evidence: { path: 'visible.json', quote: 'delivered' },
    },
    'gauntlet-roles.json': {
      conversation: { ...role, out_dir: 'conversation/run' },
      assessment: { ...role, stop_cause: completed ? null : 'timed_out' },
    },
    'visible.json': { text: 'delivered' },
    'evidence/checks.json': checks,
    'evidence/trajectory.json': {
      schema_version: 'ATIF-v1.7',
      agent: { name: 'fixture', version: '1' },
      steps: [{ step_id: 1, source: 'agent', message: 'invoked' }],
    },
    'evidence/native/session.json': { text: 'invoked' },
    'evidence/output/source.txt': { text: 'source' },
    [`${out}/result.json`]: result,
    [`${out}/assessment-completion.json`]: {
      schema_version: 1,
      run_id: run,
      status: completed ? 'completed' : 'timed_out',
      reason: 'fixture terminal state',
      terminal_at: fixtureTime(9),
      accepted_report_sha256: completed
        ? sha256Hex(JSON.stringify(result))
        : null,
      ...completionPatch,
    },
  };
  const p = publication(
    { final: 'indeterminate', gauntlet: null, checks },
    undefined,
    { ...files, ...additionalFiles },
  );
  const requirements = {
    mode: 'conversation' as const,
    story_sha256: 'a'.repeat(64),
    rubric_sha256: 'b'.repeat(64),
    check_manifest_sha256: 'c'.repeat(64),
    criteria: [
      {
        id: 'review:1',
        ordinal: 1,
        text: 'Trace claim',
        required_artifact_classes: ['normalized_trace' as const],
        check_refs: [],
      },
      {
        id: 'review:2',
        ordinal: 2,
        text: 'Grounded delivery',
        required_artifact_classes: [
          'visible_delivery' as const,
          'output' as const,
        ],
        check_refs: [],
      },
    ],
    checks: [
      {
        ordinal: 0,
        phase: 'post' as const,
        check: 'file-exists',
        args: ['answer'],
        negated: false,
        count: 1,
        authority: { kind: 'output_check' as const, sources: ['checks.sh'] },
      },
    ],
  };
  return { p, requirements, out };
}
test('completed interaction and successful output checks survive a timed-out assessment publication', () => {
  const { p, requirements } = conversationPublication(false);
  const e = readAttemptEvidence(p);
  const m = measureAttempt(e, requirements);
  expect(m.interaction.verdict).toBe('pass');
  expect(m.checks.map((c) => c.verdict)).toEqual(['pass']);
  expect(m.criteria.map((c) => c.verdict)).toEqual([null, null]);
  expect(e.subject_cost_usd).toBe(2);
});
test('trajectory corruption loses only dependent claims; manifest identity corruption loses every attribution', () => {
  const { p, requirements } = conversationPublication(true);
  expect(
    measureAttempt(readAttemptEvidence(p), requirements).criteria.map(
      (c) => c.verdict,
    ),
  ).toEqual(['pass', 'pass']);
  writeFileSync(join(p.runDir, 'evidence/trajectory.json'), 'corrupted');
  const m = measureAttempt(readAttemptEvidence(p), requirements);
  expect(m.criteria.map((c) => c.verdict)).toEqual([null, 'pass']);
  expect(m.checks[0]!.verdict).toBe('pass');
  const missing = readAttemptEvidence({
    ...p,
    expectedIdentity: { ...p.expectedIdentity, sample_id: 'foreign' },
  });
  expect(
    measureAttempt(missing, requirements).criteria.map((c) => c.verdict),
  ).toEqual([null, null]);
  expect(measureAttempt(missing, requirements).checks[0]!.verdict).toBeNull();
});

test('a malformed completed marker cannot authenticate accepted criterion rows', () => {
  const { p, requirements } = conversationPublication(true, {
    terminal_at: 'not-a-time',
  });
  expect(
    measureAttempt(readAttemptEvidence(p), requirements).criteria.map(
      (c) => c.verdict,
    ),
  ).toEqual([null, null]);
});

test('an authenticated process check loses its claim when the normalization evidence is damaged', () => {
  const { p, requirements } = conversationPublication(true);
  const processRequirements = {
    ...requirements,
    checks: requirements.checks.map((c) => ({
      ...c,
      authority: { ...c.authority, kind: 'process_check' as const },
    })),
  };
  writeFileSync(join(p.runDir, 'evidence/trajectory.json'), 'corrupted');
  expect(
    measureAttempt(readAttemptEvidence(p), processRequirements).checks[0]!
      .verdict,
  ).toBeNull();
});

test('retained false check rows count only with authenticated completed phase evidence', () => {
  const { requirements } = conversationPublication(false);
  const checks = [
    {
      phase: 'post',
      check: 'file-exists',
      args: ['answer'],
      negated: false,
      passed: false,
      detail: 'absent',
    },
  ];
  expect(
    measureAttempt(
      readAttemptEvidence(publication({ checks, error: null })),
      requirements,
    ).checks[0]!.verdict,
  ).toBe('fail');
  expect(
    measureAttempt(
      readAttemptEvidence(
        publication({ checks, error: { stage: 'checks', message: 'crash' } }),
      ),
      requirements,
    ).checks[0]!.verdict,
  ).toBeNull();
});

test('completed report status must agree with its accepted detailed criteria', () => {
  const { p, requirements } = conversationPublication(
    true,
    {},
    { status: 'fail' },
  );
  expect(
    measureAttempt(readAttemptEvidence(p), requirements).criteria.map(
      (c) => c.verdict,
    ),
  ).toEqual([null, null]);
});

test('the expected-check multiset never spends one literal record twice through a wildcard', () => {
  const { p, requirements } = conversationPublication(false);
  const base = requirements.checks[0]!;
  const obligations = {
    ...requirements,
    checks: [
      { ...base, ordinal: 0, args: null },
      { ...base, ordinal: 1 },
    ],
  };
  const rows = measureAttempt(readAttemptEvidence(p), obligations).checks;
  expect(rows.find((r) => r.id === 'check:0')!.verdict).toBeNull();
  expect(rows.find((r) => r.id === 'check:1')!.verdict).toBe('pass');
});

test.each([
  'missing',
  'corrupt',
] as const)('%s visible evidence cannot be replaced by an authenticated same-suffix workdir file', (damage) => {
  const { p, requirements } = conversationPublication(
    true,
    {},
    {},
    {
      'coding-agent-workdir/visible.json': { text: 'candidate alias' },
    },
  );
  const visible = p.artifacts.find(
    (r) => r.path.split('/').length === 2 && r.path.endsWith('/visible.json'),
  )!;
  if (damage === 'missing')
    p.artifacts = p.artifacts.filter((r) => r !== visible);
  else writeFileSync(join(p.resultsRoot, visible.path), 'corrupted');
  const evidence = readAttemptEvidence(p);
  expect(evidence.publication_valid).toBe(true);
  expect(
    evidence.artifacts.some((r) =>
      r.path.endsWith('/coding-agent-workdir/visible.json'),
    ),
  ).toBe(true);
  const measured = measureAttempt(evidence, requirements);
  expect(measured.interaction.verdict).toBeNull();
  expect(measured.criteria.map((r) => r.verdict)).toEqual(['pass', null]);
  expect(measured.checks[0]!.verdict).toBe('pass');
});

test('supporting evidence links use exact attempt-root files without nested suffix aliases', () => {
  const { p, requirements } = conversationPublication(
    true,
    {},
    {},
    {
      'coding-agent-workdir/conversation.json': {},
      'coding-agent-workdir/evidence/checks.json': [],
      'coding-agent-workdir/verdict.json': {},
    },
  );
  const measured = measureAttempt(readAttemptEvidence(p), requirements);
  const run = p.artifacts[0]!.path.split('/')[0]!;
  expect(measured.interaction.evidence.map((r) => r.path)).toEqual([
    `${run}/conversation.json`,
    `${run}/visible.json`,
  ]);
  expect(measured.checks[0]!.evidence.map((r) => r.path)).toEqual([
    `${run}/evidence/checks.json`,
  ]);
  const legacy = readAttemptEvidence(p);
  legacy.assessment_report = null;
  const qa = measureAttempt(legacy, { ...requirements, mode: 'qa' });
  expect(
    qa.criteria[0]!.evidence.filter((r) =>
      r.path.endsWith('/verdict.json'),
    ).map((r) => r.path),
  ).toEqual([`${run}/verdict.json`]);
});

test('exact check entries consume only their declared count before allocating wildcard records', () => {
  const { p, requirements } = conversationPublication(false);
  const evidence = readAttemptEvidence(p);
  const record = evidence.checks![0]!;
  const base = requirements.checks[0]!;
  evidence.checks = [{ ...record }, { ...record }];
  const measured = measureAttempt(evidence, {
    ...requirements,
    checks: [
      { ...base, ordinal: 0, args: null },
      { ...base, ordinal: 1 },
    ],
  });
  expect(measured.checks.map((r) => r.verdict)).toEqual(['pass', 'pass']);
});

test('criterion check dependencies require the declared checker records without inferring their verdict', () => {
  const { requirements } = conversationPublication(false);
  const spec = {
    ...requirements,
    mode: 'qa' as const,
    criteria: [
      {
        ...requirements.criteria[0]!,
        required_artifact_classes: ['check_dispositions' as const],
        check_refs: [{ ordinal: 0, scope: 'Output existence only' }],
      },
    ],
  };
  const gauntlet = {
    status: 'pass',
    summary: 's',
    reasoning: 'r',
    run_id: 'g',
    criteria: [
      {
        criterion: 'Trace claim',
        verdict: 'pass',
        evidence: 'accepted explanation',
      },
    ],
  };
  expect(
    measureAttempt(
      readAttemptEvidence(publication({ gauntlet, checks: [] })),
      spec,
    ).criteria[0]!.verdict,
  ).toBeNull();
  const checks = [
    {
      phase: 'post',
      check: 'file-exists',
      args: ['answer'],
      negated: false,
      passed: false,
      checker_status: 'completed',
      detail: 'absent',
    },
  ];
  expect(
    measureAttempt(readAttemptEvidence(publication({ gauntlet, checks })), spec)
      .criteria[0]!.verdict,
  ).toBe('pass');
});

test('conversation assessment still refuses shortened labels despite a valid accepted marker', () => {
  const { p, requirements } = conversationPublication(
    true,
    {},
    {
      criteria: [
        { criterion: 'Trace', verdict: 'pass', evidence: 'native invocation' },
        {
          criterion: 'Delivery',
          verdict: 'pass',
          evidence: 'supplied source and delivered review',
        },
      ],
    },
  );
  const evidence = readAttemptEvidence(p);
  expect(evidence.assessment_report).not.toBeNull();
  expect(
    measureAttempt(evidence, requirements).criteria.map((c) => c.verdict),
  ).toEqual([null, null]);
});
