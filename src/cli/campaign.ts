// src/cli/campaign.ts

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { currentCheckoutSha } from '../appliance/git.ts';
import { acquireCorpus } from '../campaign/acquire.ts';
import {
  buildEstimates,
  lookupEstimate,
  serializeEstimates,
} from '../campaign/estimates.ts';
import {
  loadCorpus,
  loadManifest,
  recordFromRunDir,
} from '../campaign/replay.ts';
import {
  type SimBlock,
  type SimConfig,
  SimConfigError,
  type SimResult,
  simulate,
  toSimBlocks,
} from '../campaign/simulate.ts';
import { EstimatesArtifactSchema } from '../contracts/estimates.ts';
import type { ReplayRecord } from '../contracts/replay.ts';

/** CLI-boundary error: message to stderr, exit 1 (the run-all pattern). */
function cliError(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function catchCliError(err: unknown): never {
  return cliError(err instanceof Error ? err.message : String(err));
}

/** Guard-cast: bookkeeping arrays built in lockstep with the loop index, so
 * a miss is an internal invariant violation — loud, never defaulted. */
function expectAt<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) cliError(`internal: no ${what} at index ${i}`);
  return v;
}

function requireDir(flag: string, dir: string): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    cliError(`${flag} does not exist or is not a directory: ${dir}`);
  }
}

export interface CampaignAcquireOptions {
  runsFile: string;
  resultsRoot: string;
  out: string;
}

export async function campaignAcquire(
  opts: CampaignAcquireOptions,
): Promise<void> {
  try {
    if (!existsSync(opts.runsFile)) {
      cliError(`--runs-file does not exist: ${opts.runsFile}`);
    }
    requireDir('--results-root', opts.resultsRoot);
    const runIds = readFileSync(opts.runsFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    const command = `quorum campaign acquire --runs-file ${opts.runsFile} --results-root ${opts.resultsRoot} --out ${opts.out}`;
    const manifest = await acquireCorpus({
      resultsRoot: opts.resultsRoot,
      runIds,
      outDir: opts.out,
      sourceHost: hostname(),
      now: new Date().toISOString(), // CLI boundary: wall time OK here (recorded, not hashed)
      command,
    });
    process.stdout.write(
      `acquired ${manifest.runs.length} runs (${manifest.missing_run_ids.length} missing) + ${manifest.batches.length} batches → ${opts.out}\n`,
    );
  } catch (err: unknown) {
    catchCliError(err);
  }
}

export interface CampaignEstimatesOptions {
  corpus?: string;
  manifest?: string;
  scanResults?: string;
  inclusion?: string;
  out?: string;
}

/** Committed inclusion manifest: what `--scan-results` prints and a
 *  maintainer reviews + commits before `--inclusion` consumes it. */
interface InclusionManifest {
  run_ids: string[];
  hashes?: Record<string, string>;
  credential_pools?: Record<string, string>;
}

/** Parse the committed inclusion manifest, rejecting malformed entries
 *  LOUDLY: the manifest is a frozen, reviewed set, so a non-string
 *  run_ids member or hash/credential_pools value is a usage error naming
 *  the offending index/key — never a silent filter that quietly changes
 *  what gets estimated. */
function parseInclusion(path: string): InclusionManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    cliError(`--inclusion unreadable: ${path}: ${String(err)}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    cliError(`--inclusion must be a JSON object: ${path}`);
  }
  const obj = raw as Record<string, unknown>;
  const runIdsRaw = obj['run_ids'];
  if (!Array.isArray(runIdsRaw)) {
    cliError(`--inclusion run_ids must be an array: ${path}`);
  }
  const runIds: string[] = [];
  for (const [i, entry] of runIdsRaw.entries()) {
    if (typeof entry !== 'string') {
      cliError(
        `--inclusion run_ids[${i}] must be a string, got ${typeof entry}`,
      );
    }
    runIds.push(entry);
  }
  const readStringMap = (
    field: 'hashes' | 'credential_pools',
  ): Record<string, string> | undefined => {
    const value = obj[field];
    if (value === undefined) return undefined;
    if (typeof value !== 'object' || value === null) {
      cliError(`--inclusion ${field} must be an object: ${path}`);
    }
    const out: Record<string, string> = {};
    for (const [key, v] of Object.entries(value)) {
      if (typeof v !== 'string') {
        cliError(
          `--inclusion ${field}[${key}] must be a string, got ${typeof v}`,
        );
      }
      out[key] = v;
    }
    return out;
  };
  const hashes = readStringMap('hashes');
  const credentialPools = readStringMap('credential_pools');
  return {
    run_ids: runIds,
    ...(hashes !== undefined ? { hashes } : {}),
    ...(credentialPools !== undefined
      ? { credential_pools: credentialPools }
      : {}),
  };
}

/** Scan-print mode: local runs whose verdict parses with valid
 *  wall/identity become the inclusion manifest for maintainer review +
 *  commit. Printed to stdout only — no artifact is written. */
function scanAndPrintInclusion(resultsRoot: string): void {
  requireDir('--scan-results', resultsRoot);
  const rows: Array<{ run_id: string; sha256: string }> = [];
  for (const name of readdirSync(resultsRoot).sort()) {
    const dir = join(resultsRoot, name);
    if (!existsSync(join(dir, 'verdict.json'))) continue;
    try {
      // recordFromRunDir throws on missing identity/invalid wall —
      // exactly the exclusion rule for inclusion candidates.
      recordFromRunDir(dir, name);
    } catch {
      continue; // invalid wall/identity → excluded from inclusion
    }
    rows.push({
      run_id: name,
      sha256: Bun.SHA256.hash(readFileSync(join(dir, 'verdict.json')), 'hex'),
    });
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        run_ids: rows.map((r) => r.run_id),
        hashes: Object.fromEntries(
          rows.map((r): [string, string] => [r.run_id, r.sha256]),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

/** Token volume for one run (C3 pricing overrides): the frozen sidecar's
 *  total_tokens. Absent/unreadable sidecar or a missing key reads as null —
 *  a corpus predating token capture is legitimate history. A PRESENT but
 *  invalid value (negative/fractional/non-finite) is corrupt data: token
 *  counts are nonnegative integers, so ingestion fails closed naming the
 *  run rather than pricing garbage. */
function readTokensTotal(runDir: string): number | null {
  let raw: unknown;
  try {
    raw = JSON.parse(
      readFileSync(join(runDir, 'coding-agent-token-usage.json'), 'utf8'),
    );
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  if (!('total_tokens' in raw)) return null;
  const tokens = (raw as Record<string, unknown>)['total_tokens'];
  if (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens < 0) {
    cliError(
      `token sidecar ${join(runDir, 'coding-agent-token-usage.json')} carries an invalid total_tokens (${JSON.stringify(tokens)}) — token counts are nonnegative integers; fix or regenerate the sidecar`,
    );
  }
  return tokens;
}

export function campaignEstimates(opts: CampaignEstimatesOptions): void {
  try {
    // Scan-only mode: --scan-results without --inclusion prints the
    // inclusion manifest and nothing else — no corpus, no replay manifest,
    // no artifact. It runs BEFORE any corpus loading, so a bare scan never
    // requires (or touches) the other flags.
    if (opts.scanResults !== undefined && opts.inclusion === undefined) {
      scanAndPrintInclusion(opts.scanResults);
      return;
    }
    // Artifact mode (including --scan-results + --inclusion, where the scan
    // root only names where inclusion reads from) needs the corpus triple;
    // a missing one is a usage error, not a library crash.
    if (
      opts.corpus === undefined ||
      opts.manifest === undefined ||
      opts.out === undefined
    ) {
      cliError(
        '--corpus, --manifest, and --out are required (only a bare --scan-results scan omits them)',
      );
    }
    const corpus = opts.corpus;
    const manifestPath = opts.manifest;
    const outPath = opts.out;
    const manifest = loadManifest(manifestPath);
    const loaded = loadCorpus(corpus, manifest);
    const inputs = [...loaded.records.values()].map((record) => {
      // finished_at re-read for generated_at derivation: wall + started.
      const verdict = JSON.parse(
        readFileSync(join(corpus, record.run_id, 'verdict.json'), 'utf8'),
      ) as { finished_at: string };
      return {
        record,
        finished_at: verdict.finished_at,
        tokens_total: readTokensTotal(join(corpus, record.run_id)),
      };
    });
    if (opts.inclusion !== undefined) {
      const inclusion = parseInclusion(opts.inclusion);
      const committedHashes = inclusion.hashes ?? {};
      const resultsRoot = opts.scanResults ?? 'results';
      for (const runId of inclusion.run_ids) {
        const dir = join(resultsRoot, runId);
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          cliError(`inclusion run ${runId}: no run dir at ${dir}`);
        }
        const verdictPath = join(dir, 'verdict.json');
        if (!existsSync(verdictPath)) {
          cliError(
            `inclusion run ${runId}: verdict.json missing at ${verdictPath}`,
          );
        }
        // Integrity gate: every included run must match the reviewed,
        // committed hash — a missing entry or a changed verdict is
        // divergence from the reviewed manifest, never a silent skip.
        const committed = committedHashes[runId];
        if (committed === undefined) {
          cliError(
            `inclusion run ${runId}: no committed hash in ${opts.inclusion}`,
          );
        }
        const actual = Bun.SHA256.hash(readFileSync(verdictPath), 'hex');
        if (actual !== committed) {
          cliError(
            `inclusion run ${runId}: verdict.json hash mismatch (committed ${committed}, found ${actual})`,
          );
        }
        let record: ReplayRecord;
        try {
          record = recordFromRunDir(dir, runId);
        } catch (err) {
          // The inclusion manifest is a frozen, committed set: a run_id
          // that fails to load — for ANY reason — aborts the verb. No
          // skips, no partial artifact.
          cliError(
            `inclusion run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const verdict = JSON.parse(readFileSync(verdictPath, 'utf8')) as {
          finished_at?: unknown;
        };
        if (typeof verdict.finished_at !== 'string') {
          cliError(
            `inclusion run ${runId}: verdict.json finished_at missing/not a string`,
          );
        }
        // v1 pool identity: the gate-era credential map embedded in the
        // inclusion manifest, falling back to the credential name
        // (estimates aggregate over pools; they never dispatch on them).
        inputs.push({
          record: {
            ...record,
            pool_id:
              inclusion.credential_pools?.[record.credential] ??
              record.credential,
          },
          finished_at: verdict.finished_at,
          tokens_total: readTokensTotal(dir),
        });
      }
    }
    // buildEstimates throws on zero inputs; surface that as a CLI error.
    if (inputs.length === 0) {
      cliError(
        'no records to estimate — corpus is empty and no inclusion runs loaded',
      );
    }
    const artifact = buildEstimates(inputs, {
      sources: [
        corpus,
        ...(opts.inclusion !== undefined ? [resultsRootOf(opts)] : []),
      ],
    });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, serializeEstimates(artifact), { mode: 0o644 });
    process.stdout.write(
      `estimates: ${artifact.entries.length} entries, ${artifact.corpus.run_count} runs → ${outPath}\n`,
    );
  } catch (err: unknown) {
    catchCliError(err);
  }
}

function resultsRootOf(opts: CampaignEstimatesOptions): string {
  return opts.scanResults ?? 'results';
}

interface SweepConfig extends SimConfig {
  pool_identity: 'target' | 'legacy';
}

type SweepPreset = 'default' | 'oracle' | 'grader-active';
type PoolIdentity = 'target' | 'legacy';
/** Every emitted row (jsonl, table, stdout) names its provenance so an
 *  overridden sensitivity sweep can never masquerade as another preset. */
type SweepLabel = SweepPreset | 'config';

export interface CampaignSimulateOptions {
  corpus: string;
  manifest: string;
  estimates: string;
  sweep?: string;
  config?: string;
  poolIdentity?: PoolIdentity;
  ordering?: SimConfig['ordering'];
  graderOccupancy?: SimConfig['grader_occupancy'];
  sealAllowanceMin?: string;
  out: string;
}

const SUBJECT_CAPS = [5, 15, 20];
const GLOBAL_CAPS = [8, 12, 20, 24];
const GRADER_CAPS = [5, 15, 20];
const ORDERINGS: ReadonlyArray<SimConfig['ordering']> = [
  'estimates',
  'oracle',
  'historical-fifo',
];
const OCCUPANCIES: ReadonlyArray<SimConfig['grader_occupancy']> = [
  'gauntlet',
  'gauntlet-active',
  'wall',
];

/** The `default` preset: both pool identities × 36 cap grids. The
 * sensitivity presets (`oracle`, `grader-active`) pin one dimension and run
 * the target identity only. Explicit --ordering/--grader-occupancy flags
 * override whatever the preset would pin. */
function sweepConfigs(
  preset: SweepPreset,
  poolsFor: (identity: PoolIdentity) => string[],
  ordering: SimConfig['ordering'],
  occupancy: SimConfig['grader_occupancy'],
): SweepConfig[] {
  const identities: ReadonlyArray<PoolIdentity> =
    preset === 'default' ? ['target', 'legacy'] : ['target'];
  const configs: SweepConfig[] = [];
  for (const pool_identity of identities) {
    const pools = poolsFor(pool_identity);
    for (const sc of SUBJECT_CAPS) {
      for (const gc of GLOBAL_CAPS) {
        for (const rc of GRADER_CAPS) {
          configs.push({
            pool_identity,
            subject_caps: Object.fromEntries(
              pools.map((p): [string, number] => [p, sc]),
            ),
            grader_cap: rc,
            global_cap: gc,
            ordering,
            grader_occupancy: occupancy,
          });
        }
      }
    }
  }
  return configs;
}

interface ExplicitConfig {
  subject_caps: Record<string, number>;
  grader_cap: number;
  global_cap: number;
  ordering: SimConfig['ordering'];
  grader_occupancy: SimConfig['grader_occupancy'];
}

function parseExplicitConfig(json: string): ExplicitConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    cliError('--config is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) {
    cliError('--config must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const subjectCaps = obj['subject_caps'];
  if (typeof subjectCaps !== 'object' || subjectCaps === null) {
    cliError('--config.subject_caps must be an object');
  }
  for (const [pool, cap] of Object.entries(subjectCaps)) {
    if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1) {
      cliError(`--config.subject_caps[${pool}] must be an integer >= 1`);
    }
  }
  const graderCap = obj['grader_cap'];
  if (
    typeof graderCap !== 'number' ||
    !Number.isInteger(graderCap) ||
    graderCap < 1
  ) {
    cliError('--config.grader_cap must be an integer >= 1');
  }
  const globalCap = obj['global_cap'];
  if (
    typeof globalCap !== 'number' ||
    !Number.isInteger(globalCap) ||
    globalCap < 1
  ) {
    cliError('--config.global_cap must be an integer >= 1');
  }
  const ordering = obj['ordering'];
  if (
    typeof ordering !== 'string' ||
    !ORDERINGS.includes(ordering as SimConfig['ordering'])
  ) {
    cliError(`--config.ordering must be one of ${ORDERINGS.join('|')}`);
  }
  const occupancy = obj['grader_occupancy'];
  if (
    typeof occupancy !== 'string' ||
    !OCCUPANCIES.includes(occupancy as SimConfig['grader_occupancy'])
  ) {
    cliError(
      `--config.grader_occupancy must be one of ${OCCUPANCIES.join('|')}`,
    );
  }
  return {
    subject_caps: Object.fromEntries(
      Object.entries(subjectCaps).map(([p, c]): [string, number] => [
        p,
        c as number,
      ]),
    ),
    grader_cap: graderCap,
    global_cap: globalCap,
    ordering: ordering as SimConfig['ordering'],
    grader_occupancy: occupancy as SimConfig['grader_occupancy'],
  };
}

export function campaignSimulate(opts: CampaignSimulateOptions): void {
  try {
    // Documented alternatives: passing both must be loud, never a silent
    // --config-wins.
    if (opts.sweep !== undefined && opts.config !== undefined) {
      cliError(
        '--sweep and --config are mutually exclusive — pass one or the other',
      );
    }
    // --pool-identity selects the identity for ONE explicit config; in sweep
    // mode (explicit or defaulted) it has no meaning and would be silently
    // ignored — a usage error, never a quiet no-op.
    if (opts.poolIdentity !== undefined && opts.config === undefined) {
      cliError('--pool-identity is valid only with --config');
    }
    const poolIdentity = opts.poolIdentity ?? 'target';
    if (poolIdentity !== 'target' && poolIdentity !== 'legacy') {
      cliError('--pool-identity must be target|legacy');
    }
    if (opts.ordering !== undefined && !ORDERINGS.includes(opts.ordering)) {
      cliError(`--ordering must be one of ${ORDERINGS.join('|')}`);
    }
    if (
      opts.graderOccupancy !== undefined &&
      !OCCUPANCIES.includes(opts.graderOccupancy)
    ) {
      cliError(`--grader-occupancy must be one of ${OCCUPANCIES.join('|')}`);
    }
    const sealRaw = opts.sealAllowanceMin ?? '15';
    if (!/^\d+$/.test(sealRaw)) {
      cliError('--seal-allowance-min must be a non-negative integer');
    }
    const allowanceMs = Number.parseInt(sealRaw, 10) * 60_000;

    const manifest = loadManifest(opts.manifest);
    const loaded = loadCorpus(opts.corpus, manifest);
    const estimates = EstimatesArtifactSchema.parse(
      JSON.parse(readFileSync(opts.estimates, 'utf8')),
    );

    // Pool identity selection: legacy swaps subject_pool per comparison.
    const legacyByComparison = new Map(
      manifest.comparisons.map(
        (c) => [c.comparison_id, c.legacy_pool_id] as const,
      ),
    );
    const estimateFor = (runId: string): number => {
      const rec = loaded.records.get(runId);
      if (rec === undefined) {
        throw new SimConfigError(`missing record for ${runId}`);
      }
      return (
        lookupEstimate(estimates, {
          scenario: rec.scenario,
          agent: rec.agent,
          credential: rec.credential,
          os: rec.os,
        }).duration_s * 1000
      );
    };
    const blocksFor = (identity: PoolIdentity): SimBlock[] =>
      toSimBlocks(loaded, estimateFor).map((b) =>
        identity === 'target'
          ? b
          : {
              ...b,
              samples: b.samples.map((s) => ({
                ...s,
                subject_pool:
                  legacyByComparison.get(b.comparison_id) ?? s.subject_pool,
              })),
            },
      );
    // Caps must be keyed by the pool names the identity's blocks actually
    // carry: target blocks name comparison pool_ids, legacy blocks name
    // legacy_pool_ids.
    const poolsFor = (identity: PoolIdentity): string[] =>
      identity === 'target'
        ? [
            ...new Set(
              loaded.blocks.flatMap((b) =>
                b.samples.map((s) => s.subject_pool),
              ),
            ),
          ]
        : [...new Set(manifest.comparisons.map((c) => c.legacy_pool_id))];

    const runOne = (
      cfg: SweepConfig,
      label: SweepLabel,
    ): SimResult & {
      config: SweepConfig;
      label: SweepLabel;
      allowance_inclusive_makespan_ms: number;
    } => {
      const result = simulate(blocksFor(cfg.pool_identity), cfg);
      return {
        ...result,
        config: cfg,
        label,
        allowance_inclusive_makespan_ms: result.makespan_ms + allowanceMs,
      };
    };

    mkdirSync(opts.out, { recursive: true });

    if (opts.config !== undefined) {
      const raw = parseExplicitConfig(opts.config);
      const pools = poolsFor(poolIdentity);
      const star = raw.subject_caps['*'];
      const subject_caps =
        star !== undefined
          ? Object.fromEntries(pools.map((p): [string, number] => [p, star]))
          : raw.subject_caps;
      const cfg: SweepConfig = {
        pool_identity: poolIdentity,
        subject_caps,
        grader_cap: raw.grader_cap,
        global_cap: raw.global_cap,
        ordering: opts.ordering ?? raw.ordering,
        grader_occupancy: opts.graderOccupancy ?? raw.grader_occupancy,
      };
      process.stdout.write(
        `${JSON.stringify(runOne(cfg, 'config'), null, 2)}\n`,
      );
      return;
    }

    const sweepName = opts.sweep ?? 'default';
    if (
      sweepName !== 'default' &&
      sweepName !== 'oracle' &&
      sweepName !== 'grader-active'
    ) {
      cliError(
        `unknown --sweep preset: ${sweepName} (default|oracle|grader-active)`,
      );
    }
    const preset = sweepName as SweepPreset;
    const ordering: SimConfig['ordering'] =
      opts.ordering ?? (preset === 'oracle' ? 'oracle' : 'estimates');
    const occupancy: SimConfig['grader_occupancy'] =
      opts.graderOccupancy ??
      (preset === 'grader-active' ? 'gauntlet-active' : 'gauntlet');
    const configs = sweepConfigs(preset, poolsFor, ordering, occupancy);
    const results = configs.map((cfg) => runOne(cfg, preset));
    const eightHoursMs = 8 * 3_600_000;

    // Reserve stress (spec-pinned): per cell, duplicate the slowest
    // ceil(20%) of its blocks (the gate's authorized +20% retry budget),
    // tagged synthetic-reserve; rerun the same configs on the inflated set.
    const stressedBlocks = (identity: PoolIdentity): SimBlock[] => {
      const base = blocksFor(identity);
      const byCell = new Map<string, SimBlock[]>();
      for (const b of base) {
        const g = byCell.get(b.cell) ?? [];
        g.push(b);
        byCell.set(b.cell, g);
      }
      const out = [...base];
      for (const cellBlocks of byCell.values()) {
        const slowest = [...cellBlocks]
          .sort(
            (a, b) =>
              Math.max(...b.samples.map((s) => s.wall_ms)) -
              Math.max(...a.samples.map((s) => s.wall_ms)),
          )
          .slice(0, Math.ceil(cellBlocks.length * 0.2));
        for (const b of slowest) {
          out.push({ ...b, block_id: `${b.block_id}/synthetic-reserve` });
        }
      }
      return out;
    };
    const stressResults = configs.map(
      (cfg) => simulate(stressedBlocks(cfg.pool_identity), cfg).makespan_ms,
    );

    writeFileSync(
      join(opts.out, 'sweep-results.jsonl'),
      `${results
        .map((r, i) =>
          JSON.stringify({
            ...r,
            stress_makespan_ms: expectAt(stressResults, i, 'stress result'),
          }),
        )
        .join('\n')}\n`,
      { mode: 0o644 },
    );
    const hrs = (ms: number): string => `${(ms / 3_600_000).toFixed(2)}h`;
    // 8h-verdict eligibility (I1): the default preset's primary reading —
    // target identity AND estimates ordering AND gauntlet occupancy AND
    // the default label, allowance-inclusive. Sensitivity sweeps (oracle,
    // grader-active, config, or any flag-overridden default run) are NEVER
    // PASS-eligible: their entries say so and the table must not contradict
    // them.
    const passEligible = (r: (typeof results)[number]): boolean =>
      r.label === 'default' &&
      r.config.pool_identity === 'target' &&
      r.config.ordering === 'estimates' &&
      r.config.grader_occupancy === 'gauntlet' &&
      r.allowance_inclusive_makespan_ms <= eightHoursMs;
    const table = [
      '| label | pool_identity | subject_cap | global_cap | grader_cap | nominal | +reserve stress | +stress+allowance | +allowance | 8h verdict | busiest pool (attributed wait ms) |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
      ...results.map((r, i) => {
        const stress = expectAt(stressResults, i, 'stress result');
        const busiest = Object.entries(r.per_pool)
          .filter(([p]) => p !== '__global__')
          .sort((a, b) => b[1].attributed_wait_ms - a[1].attributed_wait_ms)[0];
        const subjectCap = Object.values(r.config.subject_caps)[0];
        return `| ${r.label} | ${r.config.pool_identity} | ${subjectCap ?? '—'} | ${r.config.global_cap} | ${r.config.grader_cap} | ${hrs(r.makespan_ms)} | ${hrs(stress)} | ${hrs(stress + allowanceMs)} | ${hrs(r.allowance_inclusive_makespan_ms)} | ${passEligible(r) ? 'PASS' : '—'} | ${busiest?.[0] ?? '—'} (${Math.round(busiest?.[1].attributed_wait_ms ?? 0)}) |`;
      }),
    ].join('\n');
    writeFileSync(
      join(opts.out, 'sweep-table.md'),
      `# 8h verdict rule: default preset only (target identity + estimates ordering + gauntlet occupancy) + allowance-inclusive. The stress columns add the +20% registered-reserve draw; +stress+allowance applies the same seal allowance to the stressed makespan.\n\n${table}\n`,
      { mode: 0o644 },
    );
    process.stdout.write(
      `sweep: ${results.length} runs → ${opts.out}/sweep-results.jsonl, sweep-table.md\n`,
    );
  } catch (err: unknown) {
    catchCliError(err);
  }
}

// ── D3 operator verbs: register | run | cancel (task 9c) ──────────────────
// The pinned CLI option/default table (spec §registration, R-RCV-7):
//   register: <suite> --estimates <path> (default estimates/v1.json)
//             --global-cap <int> (default DEFAULT_GLOBAL_CAP) --confirm
//            --dry-run; noninteractive — absent --confirm prints and exits 0.
//   run:      <campaign-dir> — NO options in v1.
//   cancel:   <campaign-dir> --reason <text>.

import { isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import { clockNowMs, hostStatsProbeForCli } from '../campaign/host-stats.ts';
import { realProcessIdentityProbe } from '../campaign/locks.ts';
import { cancelCampaign, resumeCampaign } from '../campaign/recovery.ts';
import { registerCampaign } from '../campaign/registration.ts';
import { parseCredentialsFile } from '../contracts/credential.ts';
import { getEnv } from '../env.ts';
import { repoRoot } from '../paths.ts';
import { RealClock } from '../scheduler/clock.ts';

/** Usage/fail-closed error for the D3 operator verbs. These verbs RESOLVE
 * exit codes — only the Commander action performs the process exit (the C8
 * boundary rule; the Phase-0 verbs acquire/estimates/simulate keep the
 * module's older exit-on-error pattern). */
export class CampaignVerbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampaignVerbError';
  }
}

/** The verbs' uniform failure exit: message to stderr, code 1 resolved. */
function verbFailure(err: unknown): number {
  process.stderr.write(
    `error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  return 1;
}

/** C12(b): the authoritative NON-CLI source-checkout discovery. No flags
 * exist on `campaign register|run` (the pinned table has none in v1), so the
 * three checkouts the drift repair and snapshot materialization drive come
 * from the seams the repo already owns: evals = the running checkout
 * (`repoRoot()` — run-from-source), gauntlet = `$GAUNTLET_ROOT` (the same
 * channel scripts/evals-container resolves the gauntlet checkout through),
 * superpowers = `$SUPERPOWERS_ROOT` (the standing host-env export every
 * needsSuperpowersRoot helper fail-fasts on). Fail-closed: an unset,
 * non-absolute, or missing directory refuses loudly — never a silent default
 * to the evals root, which would snapshot the wrong repository. */
export interface SourceCheckouts {
  readonly evalsCheckout: string;
  readonly gauntletCheckout: string;
  readonly superpowersCheckout: string;
}

export function resolveSourceCheckouts(): SourceCheckouts {
  const checkoutFromEnv = (name: string): string => {
    const value = getEnv(name);
    if (value === undefined || value === '') {
      throw new CampaignVerbError(
        `${name} is not set — the campaign verbs resolve their source checkouts from the environment (evals = this checkout, gauntlet = $GAUNTLET_ROOT, superpowers = $SUPERPOWERS_ROOT); no CLI flag exists in v1`,
      );
    }
    if (!isAbsolute(value)) {
      throw new CampaignVerbError(
        `${name} must be an absolute path (got '${value}')`,
      );
    }
    if (!existsSync(value) || !statSync(value).isDirectory()) {
      throw new CampaignVerbError(
        `${name} does not exist or is not a directory: ${value}`,
      );
    }
    return value;
  };
  return {
    evalsCheckout: repoRoot(),
    gauntletCheckout: checkoutFromEnv('GAUNTLET_ROOT'),
    superpowersCheckout: checkoutFromEnv('SUPERPOWERS_ROOT'),
  };
}

export interface CampaignRegisterOptions {
  estimates: string;
  globalCap: string;
  confirm?: boolean;
  dryRun?: boolean;
}

export function campaignRegister(
  suitePath: string,
  opts: CampaignRegisterOptions,
): number {
  try {
    const globalCap = /^-?\d+$/.test(opts.globalCap)
      ? Number(opts.globalCap)
      : Number.NaN;
    if (!Number.isInteger(globalCap) || globalCap < 1) {
      throw new CampaignVerbError(
        `--global-cap must be an integer >= 1 (got '${opts.globalCap}')`,
      );
    }
    const checkouts = resolveSourceCheckouts();
    // No --ref flags exist in v1 (the pinned table), so the verb freezes
    // what the source checkouts currently ARE: each checkout's HEAD as a
    // full SHA (R-REG-8's 40-hex-at-the-campaign-layer rule). This is the
    // appliance seam's currentCheckoutSha — no fetch, no fast-forward, the
    // tree registration actually reads.
    const evalsRef = currentCheckoutSha(
      checkouts.evalsCheckout,
      'evals checkout',
      defaultCommandRunner,
    );
    const gauntletRef = currentCheckoutSha(
      checkouts.gauntletCheckout,
      'gauntlet checkout',
      defaultCommandRunner,
    );
    // ONE seconds-based Clock for this boundary: the registration lease and
    // the estimate-staleness cutoff read the same source.
    const clock = new RealClock();
    const estimatesRaw = JSON.parse(readFileSync(opts.estimates, 'utf8'));
    const estimates = EstimatesArtifactSchema.parse(estimatesRaw);
    const suiteRaw = readFileSync(suitePath, 'utf8');
    const result = registerCampaign({
      suitePath,
      suiteRaw,
      campaignsRoot: join(repoRoot(), 'campaigns'),
      estimates,
      globalCap,
      confirm: opts.confirm === true,
      dryRun: opts.dryRun === true,
      evalsCheckout: checkouts.evalsCheckout,
      gauntletCheckout: checkouts.gauntletCheckout,
      superpowersCheckout: checkouts.superpowersCheckout,
      evalsRef,
      gauntletRef,
      runner: defaultCommandRunner,
      clock,
      identity: realProcessIdentityProbe,
      probe: hostStatsProbeForCli(repoRoot()),
      env: (key) => getEnv(key),
      registeredBy: getEnv('USER') ?? 'unknown',
      nowMs: clockNowMs(clock),
    });
    process.stdout.write(`${result.printed}\n`);
    return 0;
  } catch (err) {
    return verbFailure(err);
  }
}

export async function campaignRun(rawCampaignDir: string): Promise<number> {
  // Canonicalized at the boundary: the engine hands this path to detached
  // children that run with a different working directory, so a relative
  // argument would name a different directory there.
  const campaignDir = resolve(rawCampaignDir);
  if (!existsSync(campaignDir) || !statSync(campaignDir).isDirectory()) {
    return verbFailure(
      new CampaignVerbError(
        `campaign directory does not exist: ${campaignDir}`,
      ),
    );
  }
  // R-RCV-7: cancel-request FIRST — before checkout-env resolution or
  // snapshot-credential parsing. A missing $GAUNTLET_ROOT or a damaged
  // credentials.yaml must never block completing a cancellation the
  // operator already requested; nothing on that path reads either. This
  // mirrors resumeCampaign's own precedence and strings (recovery.ts).
  if (existsSync(join(campaignDir, 'cancel-request'))) {
    process.stdout.write(
      'cancel-request present — completing cancellation instead of resuming\n',
    );
    const result = await cancelCampaign({
      campaignDir,
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
    });
    if (!result.cancelled) {
      process.stderr.write(
        'cancel incomplete — campaign_cancelled NOT journaled; complete the operator action above, then re-run `quorum campaign cancel`\n',
      );
      return 1;
    }
    process.stdout.write(
      `campaign run finished: cancelled (${
        result.postCrash
          ? 'post-crash cancel completed'
          : 'live cancel completed'
      })\n`,
    );
    return 0;
  }
  try {
    // The checkouts are the SOURCE repos the drift repair drives
    // `git worktree remove/prune` against (their .git/worktrees hold the
    // registrations) — never the campaign dir itself (that is the worktree
    // DEST). Same non-CLI discovery as `campaign register` (C12b).
    const checkouts = resolveSourceCheckouts();
    const credentials = parseCredentialsFile(
      parseYaml(
        readFileSync(join(campaignDir, 'evals', 'credentials.yaml'), 'utf8'),
      ),
    );
    const outcome = await resumeCampaign({
      campaignDir,
      credentials,
      evalsCheckout: checkouts.evalsCheckout,
      gauntletCheckout: checkouts.gauntletCheckout,
      superpowersCheckout: checkouts.superpowersCheckout,
    });
    process.stdout.write(
      `campaign run finished: ${outcome.status}${
        outcome.reason !== undefined ? ` (${outcome.reason})` : ''
      }\n`,
    );
    return 0;
  } catch (err) {
    return verbFailure(err);
  }
}

export async function campaignCancel(
  rawCampaignDir: string,
  opts: { reason?: string },
): Promise<number> {
  const campaignDir = resolve(rawCampaignDir);
  try {
    if (!existsSync(campaignDir) || !statSync(campaignDir).isDirectory()) {
      throw new CampaignVerbError(
        `campaign directory does not exist: ${campaignDir}`,
      );
    }
    const result = await cancelCampaign({
      campaignDir,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
    });
    if (!result.cancelled) {
      // The pinned sequence did NOT complete (a group survived TERM+KILL):
      // cancelCampaign already streamed the operator action; the verb
      // returns nonzero so scripts never read an incomplete cancel as done
      // (only the CLI entrypoint exits on it).
      process.stderr.write(
        'campaign cancel incomplete — campaign_cancelled NOT journaled; complete the operator action above, then re-run the cancel\n',
      );
      return 1;
    }
    process.stdout.write(
      `campaign cancelled (${
        result.postCrash ? 'post-crash path' : 'live dispatcher'
      })\n`,
    );
    return 0;
  } catch (err) {
    return verbFailure(err);
  }
}
