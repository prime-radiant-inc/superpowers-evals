// The seal act (kernel D4a task 5): the terminus sequence over REAL tmpdir
// campaigns — a real journal (initJournalDb + electWriter), a hand-written
// sidecar in the D3 line shape, snapshot verify scripted through the
// `runner` seam, and real run-dir evidence under a real results root. No
// mocked behavior: every fixture is the artifact the production seams read.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import {
  SIDECAR_FILENAME,
  type SidecarLine,
} from '../src/campaign/contention.ts';
import {
  type ElectWriterArgs,
  type EventInput,
  electWriter,
  initJournalDb,
  openJournalRead,
} from '../src/campaign/journal.ts';
import {
  canonicalReportBytes,
  digestReportBytes,
  foldDescriptiveReport,
  REPORT_JSON_NAME,
  REPORT_MD_NAME,
  renderReportMd,
} from '../src/campaign/report.ts';
import { readSampleEvidence } from '../src/campaign/report-evidence.ts';
import {
  runTerminusSeal,
  SealError,
  type SealerWriter,
  type TerminusResult,
} from '../src/campaign/seal.ts';
import type { Campaign } from '../src/contracts/campaign/campaign.ts';
import type {
  JournalEvent,
  JournalEventType,
} from '../src/contracts/campaign/journal-events.ts';
import { FakeClock } from '../src/scheduler/clock.ts';
import {
  CRASHED_PGID,
  publishedCampaign,
  REPORT_BLOCK_1,
  REPORT_BLOCK_2,
  REPORT_RESERVE,
  reportCampaign,
  WRITER_IDENTITY,
} from './campaign-recovery-fixtures.ts';

const A_R1 = 'c1:scn:arm_a:r1';
const B_R1 = 'c1:scn:arm_b:r1';
const A_R2 = 'c1:scn:arm_a:r2';
const B_R2 = 'c1:scn:arm_b:r2';
const A_X1 = 'c1:scn:arm_a:x1';
const B_X1 = 'c1:scn:arm_b:x1';

/** One journal event waiting for the writer, with its own pinned ts. */
interface PendingEvent {
  readonly type: JournalEventType;
  readonly payload: unknown;
  readonly ts_ms: number;
}

/** A replay-legal prefix with explicit, sidecar-correlated timestamps: one
 *  event per 1000 ms from campaign_opened. The contention evaluator judges
 *  journal-derived intervals against sidecar ts_ms, so the fixture pins both
 *  from one clock. */
class Prefix {
  private tsMs = 0;
  private readonly admitted = new Set<string>();
  readonly events: PendingEvent[] = [];
  readonly doc: Campaign;

  // erasableSyntaxOnly forbids a parameter property; assign in body.
  constructor(doc: Campaign) {
    this.doc = doc;
    this.emit('campaign_opened', {
      campaign_id: doc.campaign_id,
      digest: doc.digest,
    });
  }

  private emit(type: JournalEventType, payload: unknown): number {
    this.tsMs += 1000;
    this.events.push({ type, payload, ts_ms: this.tsMs });
    return this.tsMs;
  }

  /** admit-if-needed → attempt → allocate → exposure → completed run. */
  run(spec: {
    readonly blockId: string;
    readonly sampleId: string;
    readonly attemptId: string;
    readonly runId: string;
    readonly outcome: 'pass' | 'fail';
  }): void {
    if (!this.admitted.has(spec.blockId)) {
      this.admitted.add(spec.blockId);
      this.emit('block_admitted', { block_id: spec.blockId, pools: ['p'] });
    }
    this.emit('attempt_created', {
      sample_id: spec.sampleId,
      attempt_id: spec.attemptId,
    });
    this.emit('run_allocated', {
      attempt_id: spec.attemptId,
      run_id: spec.runId,
      pgid: CRASHED_PGID,
      key_grants: [],
    });
    // Exposure carries its own tick (one ts per event, pinned from one
    // clock): the evaluator only consumes interval endpoints and terminal
    // ts, so the exposure ts itself feeds nothing here.
    this.emit('exposure_started', {
      sample_id: spec.sampleId,
      ts: this.tsMs,
    });
    this.emit('run_completed', {
      attempt_id: spec.attemptId,
      outcome: spec.outcome,
    });
  }

  raw(type: JournalEventType, payload: unknown): void {
    this.emit(type, payload);
  }
}

/** The both-blocks-complete happy prefix: b1 then b2, every sample terminal.
 *  Pinned timeline (ts_ms, one tick per event): opened 1000; b1's service
 *  interval [3000, 10000]; b2's [12000, 19000]; final terminal 19000. */
function completePrefix(doc: Campaign): Prefix {
  const p = new Prefix(doc);
  p.run({
    blockId: REPORT_BLOCK_1,
    sampleId: A_R1,
    attemptId: 'att-1',
    runId: 'run-1',
    outcome: 'pass',
  });
  p.run({
    blockId: REPORT_BLOCK_1,
    sampleId: B_R1,
    attemptId: 'att-2',
    runId: 'run-2',
    outcome: 'pass',
  });
  p.run({
    blockId: REPORT_BLOCK_2,
    sampleId: A_R2,
    attemptId: 'att-3',
    runId: 'run-3',
    outcome: 'pass',
  });
  p.run({
    blockId: REPORT_BLOCK_2,
    sampleId: B_R2,
    attemptId: 'att-4',
    runId: 'run-4',
    outcome: 'fail',
  });
  return p;
}

/** A predicate-ILLEGAL prefix: b2's arm_b replicate never ran. */
function incompletePrefix(doc: Campaign): Prefix {
  const p = new Prefix(doc);
  p.run({
    blockId: REPORT_BLOCK_1,
    sampleId: A_R1,
    attemptId: 'att-1',
    runId: 'run-1',
    outcome: 'pass',
  });
  p.run({
    blockId: REPORT_BLOCK_1,
    sampleId: B_R1,
    attemptId: 'att-2',
    runId: 'run-2',
    outcome: 'pass',
  });
  p.run({
    blockId: REPORT_BLOCK_2,
    sampleId: A_R2,
    attemptId: 'att-3',
    runId: 'run-3',
    outcome: 'pass',
  });
  return p;
}

/** A prefix carrying one LANDED closed-window contention mint: b1 ran to
 *  completion, then the dispatcher's resolution batch replaced it with the
 *  frozen reserve (mint bundle: block_replaced FIRST, then exactly the
 *  required predecessor dispositions), the successor ran to completion, and
 *  b2 completes. The integrity audit re-compares this mint against the
 *  sidecar. b1's service interval: [3000, 10000]; final terminal 31000. */
function contentionMintPrefix(doc: Campaign): Prefix {
  const p = new Prefix(doc);
  p.run({
    blockId: REPORT_BLOCK_1,
    sampleId: A_R1,
    attemptId: 'att-1',
    runId: 'run-1',
    outcome: 'pass',
  });
  p.run({
    blockId: REPORT_BLOCK_1,
    sampleId: B_R1,
    attemptId: 'att-2',
    runId: 'run-2',
    outcome: 'pass',
  });
  p.raw('block_replaced', {
    block_id: REPORT_BLOCK_1,
    replacement_block_id: REPORT_RESERVE,
    reason: 'contention',
    kind: 'replacement',
    reserve_activation: true,
    roster: [
      { sample_id: A_X1, arm: 'arm_a', supersedes: A_R1 },
      { sample_id: B_X1, arm: 'arm_b', supersedes: B_R1 },
    ],
  });
  p.raw('sample_disposition', {
    sample_id: A_R1,
    disposition: 'excluded_block_replaced',
    superseded_by: A_X1,
  });
  p.raw('sample_disposition', {
    sample_id: B_R1,
    disposition: 'excluded_block_replaced',
    superseded_by: B_X1,
  });
  p.run({
    blockId: REPORT_RESERVE,
    sampleId: A_X1,
    attemptId: 'att-x1a',
    runId: 'run-x1a',
    outcome: 'pass',
  });
  p.run({
    blockId: REPORT_RESERVE,
    sampleId: B_X1,
    attemptId: 'att-x1b',
    runId: 'run-x1b',
    outcome: 'pass',
  });
  p.run({
    blockId: REPORT_BLOCK_2,
    sampleId: A_R2,
    attemptId: 'att-3',
    runId: 'run-3',
    outcome: 'pass',
  });
  p.run({
    blockId: REPORT_BLOCK_2,
    sampleId: B_R2,
    attemptId: 'att-4',
    runId: 'run-4',
    outcome: 'fail',
  });
  return p;
}

/** A sidecar line in the D3 shape (contention.ts's parser): all metrics
 *  in bounds unless load1 breaches the registered load1_per_core gt 2 with
 *  cpu_cores 4 → load1 > 8 breaches. */
function tel(ts: number, load1: number): SidecarLine {
  return {
    ts_ms: ts,
    load1,
    mem_available_bytes: 8 * 2 ** 30,
    swap_used_bytes: 0,
    process_count: 100,
    disk_free_bytes: 50 * 2 ** 30,
    breach: load1 > 8 ? ['load1_per_core'] : [],
  };
}

function gap(ts: number): SidecarLine {
  return { ts_ms: ts, missing: true };
}

/** Samples every 1000 ms over [first, last], load1 defaulting to 1. */
function cadence(
  first: number,
  last: number,
  loadAt: (ts: number) => number = () => 1,
): SidecarLine[] {
  const out: SidecarLine[] = [];
  for (let ts = first; ts <= last; ts += 1000) out.push(tel(ts, loadAt(ts)));
  return out;
}

/** Insert an explicit gap line at `ts` (kept in ts order): direct evidence
 *  the guard was blind between that line's real-sample neighbors. */
function withGapAt(lines: readonly SidecarLine[], ts: number): SidecarLine[] {
  const out = [...lines];
  let at = out.findIndex((line) => line.ts_ms > ts);
  if (at === -1) at = out.length;
  out.splice(at, 0, gap(ts));
  return out;
}

// --- run-dir evidence (real artifacts under a real results root) -----------

interface RunSpec {
  readonly runId: string;
  readonly outcome: 'pass' | 'fail';
  readonly model: string;
  readonly tokens: number;
  readonly usd: number;
}

const INPUT_TOKENS = 40;

/** The four pinned artifacts per run dir, in their real on-disk shapes
 *  (verdict.json / trajectory.json / coding-agent-token-usage.json /
 *  gauntlet-agent/results/<id>/result.json). */
function writeRunDir(resultsRoot: string, run: RunSpec): void {
  const dir = join(resultsRoot, run.runId);
  mkdirSync(join(dir, 'gauntlet-agent', 'results', run.runId), {
    recursive: true,
  });
  writeFileSync(
    join(dir, 'verdict.json'),
    JSON.stringify({
      schema: 1,
      final: run.outcome,
      final_reason: 'fixture verdict',
      gauntlet: {
        status: run.outcome,
        summary: 's',
        reasoning: 'r',
        run_id: run.runId,
      },
      checks: [],
      error: null,
      economics: {
        coding_agent: { duration_ms: 61000 },
        gauntlet: { duration_ms: 45000 },
        total_est_cost_usd: run.usd,
      },
    }),
  );
  writeFileSync(
    join(dir, 'trajectory.json'),
    JSON.stringify({
      schema_version: 'ATIF-v1.7',
      agent: { name: 'claude', version: '1.0.34' },
      steps: [
        {
          step_id: 1,
          timestamp: '2026-08-31T10:00:00Z',
          source: 'agent',
          model_name: run.model,
          message: 'did the work',
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, 'coding-agent-token-usage.json'),
    JSON.stringify({
      total_input: INPUT_TOKENS,
      total_cache_create: 0,
      total_cache_read: 0,
      total_output: run.tokens - INPUT_TOKENS,
      total_tokens: run.tokens,
      model: run.model,
      models: {
        [run.model]: {
          total_input: INPUT_TOKENS,
          total_cache_create: 0,
          total_cache_read: 0,
          total_output: run.tokens - INPUT_TOKENS,
          total_tokens: run.tokens,
          provider: 'anthropic',
          est_cost_usd: run.usd,
        },
      },
      est_cost_usd: run.usd,
      unpriced_models: [],
      approximations: [],
      pricing_as_of: '2026-08-31',
      duration_ms: 61000,
    }),
  );
  writeFileSync(
    join(dir, 'gauntlet-agent', 'results', run.runId, 'result.json'),
    JSON.stringify({
      schemaVersion: 5,
      runId: run.runId,
      status: run.outcome,
      summary: 's',
      reasoning: 'r',
      duration_ms: 45000,
      config: { model: 'grader-model' },
      usage: {},
    }),
  );
}

function happyRuns(): RunSpec[] {
  return [
    { runId: 'run-1', outcome: 'pass', model: 'model-a', tokens: 100, usd: 1 },
    { runId: 'run-2', outcome: 'pass', model: 'model-b', tokens: 300, usd: 3 },
    { runId: 'run-3', outcome: 'pass', model: 'model-a', tokens: 200, usd: 2 },
    { runId: 'run-4', outcome: 'fail', model: 'model-b', tokens: 400, usd: 4 },
  ];
}

/** Runs for the contention-mint prefix: b1's superseded pair, the successor
 *  pair, and b2 — every allocated run has its evidence. */
function mintRuns(): RunSpec[] {
  return [
    ...happyRuns().slice(0, 2),
    {
      runId: 'run-x1a',
      outcome: 'pass',
      model: 'model-a',
      tokens: 500,
      usd: 5,
    },
    {
      runId: 'run-x1b',
      outcome: 'pass',
      model: 'model-b',
      tokens: 700,
      usd: 7,
    },
    ...happyRuns().slice(2),
  ];
}

// --- the snapshot, scripted through the runner seam ------------------------

/** The Decision D-6 layout reconstruct/verify's own fs checks demand (marker,
 *  gauntlet tree, byte-exact executable wrapper) — real files, while HEAD and
 *  porcelain come from the scripted runner (no git repos needed). */
function seedSnapshotLayout(campaignDir: string): void {
  mkdirSync(join(campaignDir, 'evals'), { recursive: true });
  mkdirSync(join(campaignDir, 'gauntlet'), { recursive: true });
  mkdirSync(join(campaignDir, 'bin'), { recursive: true });
  writeFileSync(
    join(campaignDir, 'bin', 'gauntlet'),
    `#!/bin/sh\nexec bun '${join(campaignDir, 'gauntlet', 'src', 'index.ts')}' "$@"\n`,
  );
  chmodSync(join(campaignDir, 'bin', 'gauntlet'), 0o755);
  writeFileSync(join(campaignDir, '.quorum-snapshot-ok'), '');
}

/** Scripted CommandRunner (the D2 RecordingRunner pattern): answers
 *  `git -C <dir> rev-parse HEAD` from a map, porcelain clean. An unscripted
 *  directory fails loudly instead of inventing a HEAD. */
class SnapshotRunner implements CommandRunner {
  private readonly heads: Map<string, string>;
  constructor(heads: Record<string, string>) {
    this.heads = new Map(Object.entries(heads));
  }

  run(command: string, args: readonly string[]): CommandResult {
    if (command !== 'git' || args[0] !== '-C') {
      return {
        status: 127,
        stdout: '',
        stderr: `unexpected command: ${command} ${args.join(' ')}`,
      };
    }
    const dir = args[1] ?? '';
    if (args[2] === 'rev-parse') {
      const head = this.heads.get(dir);
      return head === undefined
        ? { status: 128, stdout: '', stderr: `no scripted HEAD for ${dir}` }
        : { status: 0, stdout: `${head}\n`, stderr: '' };
    }
    if (args[2] === 'status') {
      return { status: 0, stdout: '', stderr: '' };
    }
    return {
      status: 129,
      stdout: '',
      stderr: `unexpected git subcommand: ${args.join(' ')}`,
    };
  }
}

// --- the campaign fixture --------------------------------------------------

interface SealFixture {
  readonly dir: string;
  readonly doc: Campaign;
  readonly resultsRoot: string;
  readonly runner: SnapshotRunner;
}

function sealFixture(args: {
  readonly doc?: Campaign;
  readonly prefix: Prefix;
  readonly sidecar?: readonly SidecarLine[];
  /** Raw sidecar bytes (the torn-tail fixture writes its own damage). */
  readonly sidecarText?: string;
  readonly runs?: readonly RunSpec[];
  readonly withSnapshot?: boolean;
}): SealFixture {
  const dir = mkdtempSync(join(tmpdir(), 'seal-'));
  const resultsRoot = mkdtempSync(join(tmpdir(), 'seal-results-'));
  const doc = args.doc ?? args.prefix.doc;
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(doc));
  writeFileSync(
    join(dir, SIDECAR_FILENAME),
    args.sidecarText ??
      (args.sidecar ?? []).map((line) => `${JSON.stringify(line)}\n`).join(''),
  );
  initJournalDb(dir);
  const writer = electWriter({
    campaignDir: dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: doc,
  });
  try {
    for (const event of args.prefix.events) {
      writer.appendEvent({
        type: event.type,
        payload: event.payload,
        ts_ms: event.ts_ms,
      } satisfies EventInput);
    }
  } finally {
    writer.release();
  }
  if (args.withSnapshot !== false) seedSnapshotLayout(dir);
  for (const run of args.runs ?? happyRuns()) writeRunDir(resultsRoot, run);
  return {
    dir,
    doc,
    resultsRoot,
    runner: new SnapshotRunner({
      [join(dir, 'evals')]: doc.refs.evals,
      [join(dir, 'gauntlet')]: doc.refs.gauntlet,
    }),
  };
}

/** A capturing stream (the verb's own `stream` seam). */
function capture(): { lines: string[]; stream: { write(s: string): void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (s: string) => lines.push(s) } };
}

function terminus(
  fixture: SealFixture,
  extra: {
    readonly runner?: CommandRunner;
    readonly electSealer?: (args: ElectWriterArgs) => SealerWriter;
  } = {},
): { result: TerminusResult; lines: string[] } {
  const { lines, stream } = capture();
  const result = runTerminusSeal({
    campaignDir: fixture.dir,
    clock: new FakeClock(30), // terminus-appended events land after the prefix
    identity: WRITER_IDENTITY,
    resultsRoot: fixture.resultsRoot,
    runner: extra.runner ?? fixture.runner,
    stream,
    ...(extra.electSealer !== undefined
      ? { electSealer: extra.electSealer }
      : {}),
  });
  return { result, lines };
}

function readAllEvents(dir: string): JournalEvent[] {
  const reader = openJournalRead(dir);
  try {
    return reader.readEvents(0);
  } finally {
    reader.close();
  }
}

function adjudications(dir: string) {
  return readAllEvents(dir).filter(
    (event): event is JournalEvent & { type: 'adjudication' } =>
      event.type === 'adjudication',
  );
}

function sealedEvents(dir: string) {
  return readAllEvents(dir).filter(
    (event): event is JournalEvent & { type: 'sealed' } =>
      event.type === 'sealed',
  );
}

/** Independently recompute the report over the journal's pre-sealed prefix
 *  and the real run-dir evidence — the oracle the published bytes must equal. */
function recomputedReport(fixture: SealFixture) {
  const events = readAllEvents(fixture.dir).filter(
    (event) => event.type !== 'sealed',
  );
  return foldDescriptiveReport({
    campaign: fixture.doc,
    events,
    evidenceOf: (runId, sampleId) =>
      readSampleEvidence({
        runDir: join(fixture.resultsRoot, runId),
        sampleId,
      }),
  });
}

/** The scripted-failure journal seam: a sealer whose `sealed` append throws
 *  SQLITE_FULL while every other append (and the election/lease) is real. */
class SqliteFullAtSealed implements SealerWriter {
  private readonly real: SealerWriter;

  // erasableSyntaxOnly forbids a parameter property; assign in body.
  constructor(real: SealerWriter) {
    this.real = real;
  }

  appendEvent(input: EventInput) {
    if (input.type === 'sealed') {
      throw Object.assign(new Error('database or disk is full'), {
        code: 'SQLITE_FULL',
      });
    }
    return this.real.appendEvent(input);
  }

  release(): void {
    this.real.release();
  }
}

describe('runTerminusSeal', () => {
  test('seals an exploratory campaign: adjudications, sealed(report_digest), md+json published', () => {
    const fixture = sealFixture({
      prefix: completePrefix(reportCampaign()),
      sidecar: cadence(1000, 19000),
    });

    const { result, lines } = terminus(fixture);

    expect(result).toEqual({ outcome: 'sealed', digest: expect.any(String) });
    if (result.outcome !== 'sealed') {
      throw new Error(`expected sealed, got ${result.outcome}`);
    }

    // The digest is anchored to INDEPENDENTLY recomputed canonical bytes.
    const oracle = recomputedReport(fixture);
    const jsonBytes = readFileSync(join(fixture.dir, REPORT_JSON_NAME));
    expect(result.digest).toBe(digestReportBytes(canonicalReportBytes(oracle)));
    expect(result.digest).toBe(
      createHash('sha256').update(jsonBytes).digest('hex'),
    );

    // Published content equals the oracle byte-for-byte; md first, json last.
    const md = readFileSync(join(fixture.dir, REPORT_MD_NAME), 'utf8');
    expect(jsonBytes.equals(canonicalReportBytes(oracle))).toBe(true);
    expect(md).toBe(renderReportMd({ report: oracle, campaign: fixture.doc }));
    expect(md).toContain('DESCRIPTIVE');
    expect(
      statSync(join(fixture.dir, REPORT_MD_NAME)).mtimeMs,
    ).toBeLessThanOrEqual(
      statSync(join(fixture.dir, REPORT_JSON_NAME)).mtimeMs,
    );

    // The sealed event is the journal's last event and carries the digest.
    const events = readAllEvents(fixture.dir);
    expect(events.at(-1)?.type).toBe('sealed');
    expect(sealedEvents(fixture.dir)).toHaveLength(1);
    expect(events.at(-1)?.payload).toEqual({ report_digest: result.digest });

    // Clean sidecar: the audit/backstop append NOTHING; every sample counted.
    expect(adjudications(fixture.dir)).toHaveLength(0);
    const parsed = JSON.parse(jsonBytes.toString('utf8'));
    expect(parsed.accounting.contention_invalidated).toBe(0);
    expect(parsed.accounting.unknown_coverage).toBe(0);
    expect(parsed.accounting.denominators['c1:scn']).toBe(4);

    // The human rendering also goes to the stream.
    expect(lines.some((line) => line.includes('# Campaign report'))).toBe(true);
  });

  test('gating campaign refuses typed, journal untouched', () => {
    const { dir } = publishedCampaign({ inFlight: false });
    const { lines, stream } = capture();

    const result = runTerminusSeal({
      campaignDir: dir,
      clock: new FakeClock(30),
      identity: WRITER_IDENTITY,
      stream,
    });

    expect(result).toEqual({ outcome: 'refused_gating' });
    expect(lines.join('')).toContain('sealing gating campaigns awaits D4b');
    // The journal carries only registration's campaign_opened.
    expect(readAllEvents(dir).map((event) => event.type)).toEqual([
      'campaign_opened',
    ]);
    expect(existsSync(join(dir, REPORT_MD_NAME))).toBe(false);
    expect(existsSync(join(dir, REPORT_JSON_NAME))).toBe(false);
  });

  test('predicate not holding is a loud SealError', () => {
    const fixture = sealFixture({
      prefix: incompletePrefix(reportCampaign()),
      sidecar: cadence(1000, 12000),
      runs: happyRuns().slice(0, 3),
    });

    expect(() => terminus(fixture)).toThrow(SealError);
    expect(() => terminus(fixture)).toThrow(/seal predicate/);
    expect(sealedEvents(fixture.dir)).toHaveLength(0);
    expect(existsSync(join(fixture.dir, REPORT_MD_NAME))).toBe(false);
    expect(existsSync(join(fixture.dir, REPORT_JSON_NAME))).toBe(false);
  });

  test('snapshot drift: incident journaled, refused_drift returned, no sealed event', () => {
    const fixture = sealFixture({
      prefix: completePrefix(reportCampaign()),
      sidecar: cadence(1000, 19000),
    });
    const drifted = new SnapshotRunner({
      [join(fixture.dir, 'evals')]: 'f'.repeat(40),
      [join(fixture.dir, 'gauntlet')]: fixture.doc.refs.gauntlet,
    });

    const { result } = terminus(fixture, { runner: drifted });

    expect(result).toEqual({ outcome: 'refused_drift', trees: ['evals'] });
    const events = readAllEvents(fixture.dir);
    expect(events.at(-1)?.type).toBe('adjudication');
    const incident = adjudications(fixture.dir).at(-1);
    expect(incident?.payload).toEqual({
      cell: 'control-plane',
      disposition: 'snapshot_drift_refused',
      rationale: 'pre-seal verify at terminus: drifted trees: evals',
    });
    expect(sealedEvents(fixture.dir)).toHaveLength(0);
    expect(existsSync(join(fixture.dir, REPORT_MD_NAME))).toBe(false);
    expect(existsSync(join(fixture.dir, REPORT_JSON_NAME))).toBe(false);
  });

  test('drift re-run after repair seals and the incident stays in the journal', () => {
    const fixture = sealFixture({
      prefix: completePrefix(reportCampaign()),
      sidecar: cadence(1000, 19000),
    });
    const drifted = new SnapshotRunner({
      [join(fixture.dir, 'evals')]: 'f'.repeat(40),
      [join(fixture.dir, 'gauntlet')]: fixture.doc.refs.gauntlet,
    });

    const refused = terminus(fixture, { runner: drifted });
    expect(refused.result).toEqual({
      outcome: 'refused_drift',
      trees: ['evals'],
    });

    // Repair: the registered HEAD is what the trees carry again.
    const repaired = terminus(fixture);
    if (repaired.result.outcome !== 'sealed') {
      throw new Error(`expected sealed, got ${repaired.result.outcome}`);
    }

    const events = readAllEvents(fixture.dir);
    expect(sealedEvents(fixture.dir)).toHaveLength(1);
    expect(
      adjudications(fixture.dir).map((event) => event.payload.disposition),
    ).toEqual(['snapshot_drift_refused']); // the incident never vanishes
    expect(events.at(-1)?.type).toBe('sealed');
    expect(existsSync(join(fixture.dir, REPORT_MD_NAME))).toBe(true);
    expect(existsSync(join(fixture.dir, REPORT_JSON_NAME))).toBe(true);
    // The published bytes fold the incident-carrying journal (it is inert to
    // the accounting) and still equal the oracle.
    const oracle = recomputedReport(fixture);
    expect(
      readFileSync(join(fixture.dir, REPORT_JSON_NAME)).equals(
        canonicalReportBytes(oracle),
      ),
    ).toBe(true);
  });

  test('open-at-end breach mints contention_invalidated; coverage gap mints unknown_coverage', () => {
    // Gap at 6500 lands inside b1 [3000, 10000]; the breach (load1 9 from
    // 11000) opens a window at 13000 that is still open at campaign end
    // (19000) and covers b2 [12000, 19000].
    const fixture = sealFixture({
      prefix: completePrefix(reportCampaign()),
      sidecar: withGapAt(
        cadence(1000, 19000, (ts) => (ts >= 11000 ? 9 : 1)),
        6500,
      ),
    });

    const { result } = terminus(fixture);
    expect(result.outcome).toBe('sealed');

    const dispositions = adjudications(fixture.dir).map(
      (event) => `${event.payload.disposition}: ${event.payload.rationale}`,
    );
    expect(dispositions).toContain(
      `unknown_coverage: block=${REPORT_BLOCK_1}; seal-time contention backstop verdict unknown (uncovered interval overlaps the block interval [3000, 10000])`,
    );
    expect(dispositions).toContain(
      `contention_invalidated: block=${REPORT_BLOCK_2}; seal-time contention backstop verdict invalid (breach window still open at campaign end overlaps the block interval [12000, 19000])`,
    );

    // Both blocks left the denominators (D-4) — and the sealed bytes agree
    // with the oracle folded over the same journal.
    const json = JSON.parse(
      readFileSync(join(fixture.dir, REPORT_JSON_NAME), 'utf8'),
    );
    expect(json.accounting.unknown_coverage).toBe(1);
    expect(json.accounting.contention_invalidated).toBe(1);
    expect(json.accounting.denominators['c1:scn']).toBe(0);
    expect(
      readFileSync(join(fixture.dir, REPORT_JSON_NAME)).equals(
        canonicalReportBytes(recomputedReport(fixture)),
      ),
    ).toBe(true);
  });

  test('backstop dedupe: re-running the terminus appends no duplicate adjudications', () => {
    // A crash after a backstop adjudication landed (but before `sealed`)
    // resumes into the same terminus: the re-run must skip the block whose
    // adjudication already exists — keyed by the block named in the encoded
    // rationale, NOT by byte-equality of the detail text.
    const fixture = sealFixture({
      prefix: completePrefix(reportCampaign()),
      sidecar: withGapAt(
        cadence(1000, 19000, (ts) => (ts >= 11000 ? 9 : 1)),
        6500,
      ),
    });
    const writer = electWriter({
      campaignDir: fixture.dir,
      clock: new FakeClock(29),
      identity: WRITER_IDENTITY,
      campaign: fixture.doc,
      restrict: ['adjudication', 'sealed'],
    });
    try {
      writer.appendEvent({
        type: 'adjudication',
        payload: {
          cell: 'c1:scn',
          disposition: 'unknown_coverage',
          rationale: `block=${REPORT_BLOCK_1}; fixture-prior adjudication with a different detail text`,
        },
      });
    } finally {
      writer.release();
    }

    const { result } = terminus(fixture);
    expect(result.outcome).toBe('sealed');

    const unknown = adjudications(fixture.dir).filter(
      (event) => event.payload.disposition === 'unknown_coverage',
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.payload.rationale).toContain('fixture-prior');
    expect(sealedEvents(fixture.dir)).toHaveLength(1);
  });

  test('integrity audit: recomputed mismatch is a finding, sidecar loss a caveat, never a reversal', () => {
    // (a) Mismatch: the landed contention mint over b1 has NO corroborating
    //     breach window — the surviving sidecar is clean over [3000, 8000].
    const mismatch = sealFixture({
      prefix: contentionMintPrefix(reportCampaign()),
      sidecar: cadence(1000, 31000),
      runs: mintRuns(),
    });
    const mismatchResult = terminus(mismatch);
    expect(mismatchResult.result.outcome).toBe('sealed');
    expect(
      adjudications(mismatch.dir).map(
        (event) => `${event.payload.disposition}: ${event.payload.rationale}`,
      ),
    ).toEqual([
      `integrity_finding: block=${REPORT_BLOCK_1}; integrity audit recompute mismatch: the landed contention mint has no corroborating breach window over the predecessor interval [3000, 10000] (evidence present)`,
    ]);
    // Never a reversal: the replacement still stands and both successor and
    // b2 samples stay in the denominators.
    const mismatchJson = JSON.parse(
      readFileSync(join(mismatch.dir, REPORT_JSON_NAME), 'utf8'),
    );
    expect(mismatchJson.accounting.replacements).toBe(1);
    expect(mismatchJson.accounting.denominators['c1:scn']).toBe(4);

    // (b) Loss: the sidecar is torn at 7000 (crash mid-append) — everything
    //     after the last complete line is lost, so the mint over b1
    //     [3000, 10000] cannot be re-verified: an attribution caveat.
    const loss = sealFixture({
      prefix: contentionMintPrefix(reportCampaign()),
      sidecarText: `${cadence(1000, 6000)
        .map((line) => `${JSON.stringify(line)}\n`)
        .join('')}{"ts_ms":7000,"load1":`,
      runs: mintRuns(),
    });
    const lossResult = terminus(loss);
    expect(lossResult.result.outcome).toBe('sealed');
    const lossAdjudications = adjudications(loss.dir);
    expect(
      lossAdjudications
        .filter((event) => event.payload.disposition === 'integrity_caveat')
        .map((event) => event.payload.rationale),
    ).toEqual([
      `block=${REPORT_BLOCK_1}; integrity audit attribution caveat: sidecar evidence lost over the predecessor interval [3000, 10000] — the contention mint cannot be re-verified`,
    ]);
    expect(
      lossAdjudications.filter(
        (event) => event.payload.disposition === 'integrity_finding',
      ),
    ).toHaveLength(0);
    // Never a reversal, again: the mint still accounts (the predecessor
    // never re-enters the denominators through the finding).
    const lossJson = JSON.parse(
      readFileSync(join(loss.dir, REPORT_JSON_NAME), 'utf8'),
    );
    expect(lossJson.accounting.replacements).toBe(1);
    expect(
      readFileSync(join(loss.dir, REPORT_JSON_NAME)).equals(
        canonicalReportBytes(recomputedReport(loss)),
      ),
    ).toBe(true);
  });

  test('cancel marker before any step: cancel_in_force, nothing journaled', () => {
    const fixture = sealFixture({
      prefix: completePrefix(reportCampaign()),
      sidecar: cadence(1000, 19000),
    });
    const before = readAllEvents(fixture.dir).length;
    writeFileSync(join(fixture.dir, 'cancel-request'), 'stop\n');

    const { result } = terminus(fixture);

    expect(result).toEqual({ outcome: 'cancel_in_force' });
    expect(readAllEvents(fixture.dir)).toHaveLength(before);
    expect(sealedEvents(fixture.dir)).toHaveLength(0);
    expect(existsSync(join(fixture.dir, REPORT_MD_NAME))).toBe(false);
    expect(existsSync(join(fixture.dir, REPORT_JSON_NAME))).toBe(false);
  });

  test('SQLITE_FULL at the sealed append: storage_failed, no sealed event on disk', () => {
    const fixture = sealFixture({
      prefix: completePrefix(reportCampaign()),
      sidecar: cadence(1000, 19000),
    });
    const failing = (args: ElectWriterArgs): SealerWriter =>
      new SqliteFullAtSealed(
        electWriter({
          campaignDir: args.campaignDir,
          clock: args.clock,
          identity: args.identity,
          ...(args.campaign !== undefined ? { campaign: args.campaign } : {}),
          ...(args.restrict !== undefined ? { restrict: args.restrict } : {}),
        }),
      );

    const failed = terminus(fixture, { electSealer: failing });
    expect(failed.result).toEqual({
      outcome: 'storage_failed',
      reason: expect.stringMatching(/SQLITE_FULL|database or disk is full/),
    });
    expect(sealedEvents(fixture.dir)).toHaveLength(0);
    expect(existsSync(join(fixture.dir, REPORT_MD_NAME))).toBe(false);
    expect(existsSync(join(fixture.dir, REPORT_JSON_NAME))).toBe(false);

    // Remediation: resume re-attempts (D-13) and the seal completes.
    const retried = terminus(fixture);
    expect(retried.result.outcome).toBe('sealed');
    expect(sealedEvents(fixture.dir)).toHaveLength(1);
    expect(existsSync(join(fixture.dir, REPORT_JSON_NAME))).toBe(true);
  });
});
