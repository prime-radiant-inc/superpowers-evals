import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { isBatchDir } from './render-batch.ts';
import { resolveTarget } from './resolve-target.ts';

// `quorum costs` — a CODING-AGENT-focused cost report.
//
// For running evals, the day-to-day question is "what did the coding-agent
// side cost?" — the gauntlet (QA-driver) side is measurement overhead. This
// module loads one cost row per eval (a single run OR every produced run in a
// batch) and renders a table + aggregate of the coding-agent side. The
// gauntlet side is opt-in (--with-gauntlet), never the default.
//
// Economics is read through TOLERANT views (every leaf `unknown`), mirroring
// src/cli/render.ts: a malformed or partial economics block degrades a cell to
// an "unpriced" marker rather than crashing or coercing to $0.

// ── tolerant economics views ────────────────────────────────────────────

const TokensViewSchema = z
  .object({
    input: z.unknown(),
    output: z.unknown(),
    cache_create: z.unknown(),
    cache_read: z.unknown(),
    total: z.unknown(),
  })
  .partial()
  .passthrough();

const BlockViewSchema = z
  .object({
    duration_ms: z.unknown(),
    est_cost_usd: z.unknown(),
    model: z.unknown(),
    tokens: TokensViewSchema.nullish(),
    has_unpriced_model: z.unknown(),
  })
  .passthrough();

const EconViewSchema = z
  .object({
    coding_agent: BlockViewSchema.nullish(),
    gauntlet: BlockViewSchema.nullish(),
    partial: z.unknown(),
  })
  .passthrough();

// Just the fields the cost report reads off a verdict; everything else opaque.
const VerdictViewSchema = z
  .object({
    scenario: z.unknown(),
    coding_agent: z.unknown(),
    started_at: z.unknown(),
    finished_at: z.unknown(),
    economics: EconViewSchema.nullish(),
  })
  .passthrough();
type VerdictView = z.infer<typeof VerdictViewSchema>;

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && !Number.isNaN(v) ? v : null;
const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

// ── row shape ────────────────────────────────────────────────────────────

export interface SideCost {
  readonly estCostUsd: number | null;
  readonly tokensTotal: number | null;
  readonly tokensInput: number | null;
  readonly tokensOutput: number | null;
  readonly tokensCacheCreate: number | null;
  readonly tokensCacheRead: number | null;
  readonly durationMs: number | null;
  readonly model: string | null;
  // A side is "unpriced" when its block is absent, its est_cost_usd is missing,
  // or it carries an unpriced model — i.e. the cost is not trustworthy. The
  // renderer shows a marker for an unpriced side, never $0.00.
  readonly unpriced: boolean;
}

export interface CostRow {
  readonly scenario: string;
  readonly agent: string;
  readonly coding: SideCost;
  readonly gauntlet: SideCost;
  // The run's wall-clock span (finished_at − started_at) in ms, or null when
  // either timestamp is missing/unparseable.
  readonly wallClockMs: number | null;
}

// Read one economics side-block into a SideCost. A null/absent block is fully
// unpriced. A present block with a null/missing est_cost_usd OR a truthy
// has_unpriced_model is unpriced (tokens may still be present).
function sideCost(
  block: z.infer<typeof BlockViewSchema> | null | undefined,
): SideCost {
  if (block === null || block === undefined) {
    return {
      estCostUsd: null,
      tokensTotal: null,
      tokensInput: null,
      tokensOutput: null,
      tokensCacheCreate: null,
      tokensCacheRead: null,
      durationMs: null,
      model: null,
      unpriced: true,
    };
  }
  const cost = numOrNull(block.est_cost_usd);
  const hasUnpriced = block.has_unpriced_model === true;
  const tokens = block.tokens ?? undefined;
  return {
    estCostUsd: cost,
    tokensTotal: numOrNull(tokens?.total),
    tokensInput: numOrNull(tokens?.input),
    tokensOutput: numOrNull(tokens?.output),
    tokensCacheCreate: numOrNull(tokens?.cache_create),
    tokensCacheRead: numOrNull(tokens?.cache_read),
    durationMs: numOrNull(block.duration_ms),
    model: strOrNull(block.model),
    unpriced: cost === null || hasUnpriced,
  };
}

function wallClockMs(started: unknown, finished: unknown): number | null {
  const s = strOrNull(started);
  const f = strOrNull(finished);
  if (s === null || f === null) {
    return null;
  }
  const sMs = Date.parse(s);
  const fMs = Date.parse(f);
  if (Number.isNaN(sMs) || Number.isNaN(fMs)) {
    return null;
  }
  const span = fMs - sMs;
  return span >= 0 ? span : null;
}

// Build a CostRow from a parsed verdict view. scenario/agent prefer the
// verdict's own identity fields; the caller supplies fallbacks (the batch
// record's scenario/agent, or a run-dir-name parse) for older verdicts.
function rowFromVerdict(
  verdict: VerdictView,
  fallbackScenario: string,
  fallbackAgent: string,
): CostRow {
  const econ = verdict.economics ?? undefined;
  return {
    scenario: strOrNull(verdict.scenario) ?? fallbackScenario,
    agent: strOrNull(verdict.coding_agent) ?? fallbackAgent,
    coding: sideCost(econ?.coding_agent),
    gauntlet: sideCost(econ?.gauntlet),
    wallClockMs: wallClockMs(verdict.started_at, verdict.finished_at),
  };
}

// A run dir with no readable/parseable verdict.json -> a fully-unpriced row
// (the eval ran but its economics are unavailable; never a crash).
function unreadableRow(scenario: string, agent: string): CostRow {
  const blank = sideCost(null);
  return { scenario, agent, coding: blank, gauntlet: blank, wallClockMs: null };
}

function readVerdictView(runDir: string): VerdictView | null {
  const path = join(runDir, 'verdict.json');
  if (!existsSync(path)) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const parsed = VerdictViewSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ── batch reading ─────────────────────────────────────────────────────────

const BatchResultSchema = z
  .object({
    scenario: z.string(),
    coding_agent: z.string(),
    run_id: z.string().nullable().optional(),
    skipped: z.unknown().optional(),
  })
  .passthrough();

function batchRows(batchDir: string): CostRow[] {
  // A batch always lives at `<out-root>/batches/<id>`, and `run-all` writes its
  // run dirs at `<out-root>/<run_id>` (run-all/index.ts). So each `run_id` from
  // results.jsonl resolves against the batch dir's grandparent (the out-root) —
  // NOT the passed --results-root, which on `quorum costs <batchDir>` defaults
  // to "results" and points nowhere.
  const outRoot = resolve(dirname(dirname(batchDir)));
  const text = readFileSync(join(batchDir, 'results.jsonl'), 'utf8');
  const rows: CostRow[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    // Per-line tolerance: a corrupt or truncated record (e.g. a batch killed
    // before its final line flushed) is skipped, not allowed to abort the whole
    // report. The JSON.parse must be inside the tolerance, not before it.
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = BatchResultSchema.safeParse(raw);
    if (!parsed.success) {
      continue;
    }
    const rec = parsed.data;
    // A skipped (directive) cell produced no run — it has no coding-agent cost
    // and is omitted from the report (mirrors the matrix's "— skip" cell).
    if (rec.skipped) {
      continue;
    }
    const runId = rec.run_id ?? null;
    if (runId === null) {
      continue;
    }
    const view = readVerdictView(join(outRoot, runId));
    rows.push(
      view === null
        ? unreadableRow(rec.scenario, rec.coding_agent)
        : rowFromVerdict(view, rec.scenario, rec.coding_agent),
    );
  }
  return rows;
}

// Parse scenario/agent from a run-dir name (`<scenario>-<agent>-<stamp>-<nonce>`,
// allocateRunDir): the last two dash-segments are the stamp + nonce, the second
// from last is the agent, the rest is the scenario. A name that doesn't match
// falls back to ('?', '?') — only used when the verdict lacks identity fields.
function identityFromRunDirName(name: string): {
  scenario: string;
  agent: string;
} {
  const parts = name.split('-');
  if (parts.length < 4) {
    return { scenario: '?', agent: '?' };
  }
  const agent = parts[parts.length - 3] ?? '?';
  const scenario = parts.slice(0, parts.length - 3).join('-');
  return { scenario: scenario === '' ? '?' : scenario, agent };
}

function runDirName(dir: string): string {
  const last = dir.split('/').at(-1);
  return last !== undefined && last !== '' ? last : dir;
}

// Resolve a target (single run dir, batch dir, batch id, scenario prefix, or
// undefined for newest) to its cost rows. A batch -> one row per produced run;
// any other target -> a single row.
export function loadCostRows(
  target: string | undefined,
  resultsRoot: string,
): CostRow[] {
  const dir = resolveTarget(target, resultsRoot);
  if (isBatchDir(dir)) {
    return batchRows(dir);
  }
  const view = readVerdictView(dir);
  const fallback = identityFromRunDirName(runDirName(dir));
  if (view === null) {
    return [unreadableRow(fallback.scenario, fallback.agent)];
  }
  return [rowFromVerdict(view, fallback.scenario, fallback.agent)];
}

// ── formatting helpers (mirror src/cli/render.ts _fmt_*) ─────────────────

const UNPRICED = 'unpriced';

function fmtCost(c: number | null): string {
  return c === null ? UNPRICED : `$${c.toFixed(2)}`;
}

// A side's displayed cost: the marker whenever the side is unpriced — even when
// its aggregate est_cost_usd is a real number (a mixed-model run where one
// model went unpriced, economics.ts:243-253). The partial dollar amount is not
// trustworthy, so the table never shows it; it survives only in --json's
// est_cost_usd for inspection. This keeps the table cell and the aggregate's
// priced/unpriced split in agreement.
function fmtSideCost(side: SideCost): string {
  return side.unpriced ? UNPRICED : fmtCost(side.estCostUsd);
}

function fmtTokens(n: number | null): string {
  if (n === null || n === 0) {
    return '—';
  }
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : `${(n / 1_000).toFixed(0)}K`;
}

function fmtMs(ms: number | null): string {
  if (ms === null || ms === 0) {
    return '—';
  }
  const s = Math.trunc(ms / 1000);
  const h = Math.trunc(s / 3600);
  const rem = s % 3600;
  const m = Math.trunc(rem / 60);
  const sec = rem % 60;
  return h
    ? `${h}h ${String(m).padStart(2, '0')}m`
    : `${m}m ${String(sec).padStart(2, '0')}s`;
}

// ── ANSI (TTY-only, best-effort — mirrors render.ts:style) ───────────────

type NamedColor = 'bright_cyan' | 'bright_black' | 'bright_blue';
const NAMED_FG: Record<NamedColor, number> = {
  bright_cyan: 96,
  bright_black: 90,
  bright_blue: 94,
};

function style(
  text: string,
  opts: { fg?: NamedColor; bold?: boolean },
  color: boolean,
): string {
  if (!color) {
    return text;
  }
  const codes: string[] = [];
  if (opts.bold) {
    codes.push('1');
  }
  if (opts.fg !== undefined) {
    codes.push(String(NAMED_FG[opts.fg]));
  }
  return codes.length === 0 ? text : `\x1b[${codes.join(';')}m${text}\x1b[0m`;
}

// ── renderer ───────────────────────────────────────────────────────────

export interface RenderCostsOptions {
  readonly color: boolean;
  readonly withGauntlet?: boolean;
}

interface Column {
  readonly header: string;
  readonly cell: (row: CostRow) => string;
  // Numeric/short columns right-align; text columns (scenario/agent) left-align.
  readonly alignRight: boolean;
}

function codingColumns(withGauntlet: boolean): Column[] {
  const cols: Column[] = [
    { header: 'scenario', cell: (r) => r.scenario, alignRight: false },
    { header: 'agent', cell: (r) => r.agent, alignRight: false },
    {
      header: 'cost',
      cell: (r) => fmtSideCost(r.coding),
      alignRight: true,
    },
    {
      header: 'tokens',
      cell: (r) => fmtTokens(r.coding.tokensTotal),
      alignRight: true,
    },
    {
      header: 'in/out',
      cell: (r) =>
        `${fmtTokens(r.coding.tokensInput)}/${fmtTokens(r.coding.tokensOutput)}`,
      alignRight: true,
    },
    {
      header: 'cache',
      cell: (r) => fmtTokens(r.coding.tokensCacheRead),
      alignRight: true,
    },
    {
      header: 'duration',
      cell: (r) => fmtMs(r.coding.durationMs),
      alignRight: true,
    },
    {
      header: 'wall',
      cell: (r) => fmtMs(r.wallClockMs),
      alignRight: true,
    },
  ];
  if (withGauntlet) {
    cols.push({
      header: 'qa cost',
      cell: (r) => fmtSideCost(r.gauntlet),
      alignRight: true,
    });
  }
  return cols;
}

function pad(text: string, width: number, alignRight: boolean): string {
  return alignRight ? text.padStart(width) : text.padEnd(width);
}

// Sum of priced coding costs, and the priced/unpriced split (an unpriced row
// contributes 0 to the sum but is counted, so the total is never inflated by a
// missing measurement).
function aggregate(rows: readonly CostRow[]): {
  codingCostUsd: number;
  codingTokens: number;
  priced: number;
  unpriced: number;
} {
  let codingCostUsd = 0;
  let codingTokens = 0;
  let priced = 0;
  let unpriced = 0;
  for (const row of rows) {
    // The `unpriced` flag already folds in estCostUsd === null AND the mixed
    // has_unpriced_model case (sideCost), so it is the single source of truth
    // for the priced/unpriced split — and a mixed row's partial cost is never
    // added to the sum.
    if (row.coding.unpriced) {
      unpriced += 1;
    } else {
      priced += 1;
      codingCostUsd += row.coding.estCostUsd ?? 0;
    }
    codingTokens += row.coding.tokensTotal ?? 0;
  }
  return {
    codingCostUsd: Math.round(codingCostUsd * 1e6) / 1e6,
    codingTokens,
    priced,
    unpriced,
  };
}

export function renderCosts(
  rows: readonly CostRow[],
  opts: RenderCostsOptions,
): string {
  const sep = style(
    '─── Coding-agent costs ───────────────────────────',
    { fg: 'bright_cyan', bold: true },
    opts.color,
  );
  if (rows.length === 0) {
    return `${sep}\n  (no eval runs found)\n`;
  }
  const cols = codingColumns(opts.withGauntlet === true);
  const widths = cols.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => c.cell(r).length)),
  );
  const lines: string[] = [sep];

  const headerCells = cols.map((c, i) =>
    pad(c.header, widths[i] ?? c.header.length, c.alignRight),
  );
  lines.push(
    `  ${style(headerCells.join('  '), { fg: 'bright_blue' }, opts.color)}`,
  );

  for (const row of rows) {
    const cells = cols.map((c, i) =>
      pad(c.cell(row), widths[i] ?? 0, c.alignRight),
    );
    lines.push(`  ${cells.join('  ')}`);
  }

  const agg = aggregate(rows);
  // With zero priced rows the sum is a meaningless 0 — render the marker, not
  // "$0.00", so a fully-unpriced report never reads as a free run.
  const totalCost = agg.priced > 0 ? fmtCost(agg.codingCostUsd) : UNPRICED;
  const summary =
    `total coding cost ${totalCost} · ` +
    `${fmtTokens(agg.codingTokens)} tokens · ` +
    `${agg.priced} priced · ${agg.unpriced} unpriced`;
  lines.push('');
  lines.push(`  ${style(summary, { fg: 'bright_black' }, opts.color)}`);
  return `${lines.join('\n')}\n`;
}

// ── machine output (--json) ──────────────────────────────────────────────

interface SideJson {
  readonly est_cost_usd: number | null;
  readonly tokens_total: number | null;
  readonly tokens_input: number | null;
  readonly tokens_output: number | null;
  readonly tokens_cache_create: number | null;
  readonly tokens_cache_read: number | null;
  readonly duration_ms: number | null;
  readonly model: string | null;
  readonly unpriced: boolean;
}

interface RowJson {
  readonly scenario: string;
  readonly agent: string;
  readonly coding: SideJson;
  readonly gauntlet: SideJson;
  readonly wall_clock_ms: number | null;
}

export interface CostsJson {
  readonly rows: readonly RowJson[];
  readonly aggregate: {
    readonly coding_cost_usd: number;
    readonly coding_tokens: number;
    readonly priced: number;
    readonly unpriced: number;
  };
}

function sideJson(side: SideCost): SideJson {
  return {
    est_cost_usd: side.estCostUsd,
    tokens_total: side.tokensTotal,
    tokens_input: side.tokensInput,
    tokens_output: side.tokensOutput,
    tokens_cache_create: side.tokensCacheCreate,
    tokens_cache_read: side.tokensCacheRead,
    duration_ms: side.durationMs,
    model: side.model,
    unpriced: side.unpriced,
  };
}

export function costsJson(rows: readonly CostRow[]): CostsJson {
  const agg = aggregate(rows);
  return {
    rows: rows.map((r) => ({
      scenario: r.scenario,
      agent: r.agent,
      coding: sideJson(r.coding),
      gauntlet: sideJson(r.gauntlet),
      wall_clock_ms: r.wallClockMs,
    })),
    aggregate: {
      coding_cost_usd: agg.codingCostUsd,
      coding_tokens: agg.codingTokens,
      priced: agg.priced,
      unpriced: agg.unpriced,
    },
  };
}
