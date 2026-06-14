import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// quorum show <batch> — scenario × agent matrix renderer.
//
// Port of quorum/show.py render_batch (the oracle). Glyphs, labels, the
// Legend line, and the tally string are reproduced verbatim; do not
// paraphrase them. The Python is canonical for any drift.

// The five cell verdicts a matrix cell can take. Closed union so the glyph
// and color lookups stay exhaustive without an index-signature widening.
export type BatchVerdict =
  | 'pass'
  | 'fail'
  | 'indeterminate'
  | 'skipped'
  | 'unknown';

interface Glyph {
  readonly glyph: string;
  readonly label: string;
}

// Mirror of show.py:_GLYPHS. NOTE the unknown label is "?" (not "no verdict");
// only the Legend line spells out "no verdict". A missing-verdict cell renders
// "? ?".
export const BATCH_GLYPHS: Record<BatchVerdict, Glyph> = {
  pass: { glyph: '✓', label: 'pass' },
  fail: { glyph: '✗', label: 'fail' },
  indeterminate: { glyph: '⊘', label: 'indet' },
  skipped: { glyph: '—', label: 'skip' },
  unknown: { glyph: '?', label: '?' },
};

// Mirror of show.py:_BATCH_GLYPH_COLORS — Dracula palette. pass/fail/indet use
// the verdict colors; skipped/unknown use the label gray. Stored as rgb tuples
// here (the Python stores "rgb(r,g,b)" strings for rich); the ANSI form is the
// same truecolor sequence.
type Rgb = readonly [number, number, number];

export const BATCH_GLYPH_COLORS: Record<BatchVerdict, Rgb> = {
  pass: [80, 250, 123],
  fail: [255, 85, 85],
  indeterminate: [241, 250, 140],
  skipped: [122, 130, 148],
  unknown: [122, 130, 148],
};

// rgb -> ANSI truecolor wrap, matching src/cli/render.ts:paint (which is not
// exported, so the sequence is re-derived here rather than reused).
function paint(text: string, rgb: Rgb, on: boolean): string {
  if (!on) {
    return text;
  }
  const [r, g, b] = rgb;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

// A path is a batch dir if it contains batch.json (show.py:is_batch_dir).
export function isBatchDir(path: string): boolean {
  return existsSync(join(path, 'batch.json'));
}

// batch.json header. coding_agents is the column order; the timestamps drive
// the banner. Extra keys are preserved by batchJson but ignored by the matrix.
const BatchHeaderSchema = z.object({
  id: z.string(),
  started_at: z.string(),
  finished_at: z.string().nullable().optional(),
  coding_agents: z.array(z.string()),
});

// One results.jsonl record. run_id may be null (no run produced); skipped is a
// truthy directive marker. The oracle (show.py:render_batch) reads skipped with
// pure truthiness (`if r.get("skipped")`) and never type-checks it, so it is
// accepted as unknown here — a non-string skipped degrades one cell rather than
// aborting the whole matrix with a schema error.
const BatchResultSchema = z.object({
  scenario: z.string(),
  coding_agent: z.string(),
  run_id: z.string().nullable().optional(),
  skipped: z.unknown().optional(),
});

// verdict.json is opaque here apart from .final; narrow only that field. An
// unparseable file or a final outside the glyph set collapses to "unknown".
const VerdictFinalSchema = z.object({
  final: z.string(),
});

function isBatchVerdict(value: string): value is BatchVerdict {
  return (
    value === 'pass' ||
    value === 'fail' ||
    value === 'indeterminate' ||
    value === 'skipped' ||
    value === 'unknown'
  );
}

// Read a cell's verdict from <resultsRoot>/<runId>/verdict.json. Missing
// run_id, missing file, unparseable JSON, or an unknown `final` -> "unknown".
function cellVerdict(resultsRoot: string, runId: string | null): BatchVerdict {
  if (runId === null) {
    return 'unknown';
  }
  const verdictPath = join(resultsRoot, runId, 'verdict.json');
  if (!existsSync(verdictPath)) {
    return 'unknown';
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(verdictPath, 'utf8'));
  } catch {
    return 'unknown';
  }
  const parsed = VerdictFinalSchema.safeParse(raw);
  if (!parsed.success) {
    return 'unknown';
  }
  const final = parsed.data.final;
  return isBatchVerdict(final) ? final : 'unknown';
}

function readResults(batchDir: string): z.infer<typeof BatchResultSchema>[] {
  const text = readFileSync(join(batchDir, 'results.jsonl'), 'utf8');
  const rows: z.infer<typeof BatchResultSchema>[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    rows.push(BatchResultSchema.parse(JSON.parse(line)));
  }
  return rows;
}

function cellKey(scenario: string, agent: string): string {
  // Tab is absent from scenario/agent names, so it is a safe composite-key
  // separator for the per-cell lookup map.
  return `${scenario}\t${agent}`;
}

export interface RenderBatchArgs {
  readonly batchDir: string;
  readonly resultsRoot: string;
  readonly color: boolean;
}

// Port of show.py:render_batch. Returns the full multi-line table (banner,
// blank, header, separator, one row per scenario, blank, Legend, tally) with a
// trailing newline, matching rich's Console.print line-by-line.
export function renderBatch(args: RenderBatchArgs): string {
  const header = BatchHeaderSchema.parse(
    JSON.parse(readFileSync(join(args.batchDir, 'batch.json'), 'utf8')),
  );
  const rows = readResults(args.batchDir);

  const agents = header.coding_agents;
  const scenarios = [...new Set(rows.map((r) => r.scenario))].sort();

  const cellVerdicts = new Map<string, BatchVerdict>();
  const counts: Record<BatchVerdict, number> = {
    pass: 0,
    fail: 0,
    indeterminate: 0,
    skipped: 0,
    unknown: 0,
  };

  for (const r of rows) {
    const key = cellKey(r.scenario, r.coding_agent);
    // Truthiness gate, mirroring show.py's `if r.get("skipped")`: any truthy
    // value (a directive string, true, ...) marks the cell skipped; falsy or
    // absent does not.
    if (r.skipped) {
      cellVerdicts.set(key, 'skipped');
      counts.skipped += 1;
      continue;
    }
    const verdict = cellVerdict(args.resultsRoot, r.run_id ?? null);
    cellVerdicts.set(key, verdict);
    counts[verdict] += 1;
  }

  // Column widths grow to fit content (show.py).
  let scenW = Math.max(...scenarios.map((s) => s.length), 0);
  scenW = Math.max(scenW, 'scenario'.length);
  const cellW = Math.max(...agents.map((a) => a.length), '⊘ indet'.length);

  const lines: string[] = [];

  const banner =
    `batch ${header.id} · started ${header.started_at}` +
    (header.finished_at !== undefined && header.finished_at !== null
      ? ` · finished ${header.finished_at}`
      : '');
  lines.push(banner);
  lines.push('');

  const headerRow = `| ${'scenario'.padEnd(scenW)} | ${agents
    .map((a) => a.padEnd(cellW))
    .join(' | ')} |`;
  lines.push(headerRow);

  const sep = `|${'-'.repeat(scenW + 2)}|${agents
    .map(() => '-'.repeat(cellW + 2))
    .join('|')}|`;
  lines.push(sep);

  for (const s of scenarios) {
    const rowCells = agents.map((a) => {
      const verdict = cellVerdicts.get(cellKey(s, a)) ?? 'unknown';
      const { glyph, label } = BATCH_GLYPHS[verdict];
      const text = `${glyph} ${label}`.padEnd(cellW);
      return paint(text, BATCH_GLYPH_COLORS[verdict], args.color);
    });
    lines.push(`| ${s.padEnd(scenW)} | ${rowCells.join(' | ')} |`);
  }

  lines.push('');
  lines.push(
    'Legend: ✓ pass   ✗ fail   ⊘ indeterminate   — skipped (directive)   ? no verdict',
  );
  const tally =
    `${counts.pass} ✓ · ${counts.fail} ✗ · ` +
    `${counts.indeterminate} ⊘ · ${counts.skipped} —` +
    (counts.unknown ? ` · ${counts.unknown} ?` : '');
  lines.push(tally);

  return `${lines.join('\n')}\n`;
}

// --json batch payload shape (the integrator prints this for `show --json` on a
// batch): the parsed batch.json header spread with a `results` array of the
// parsed results.jsonl records. Returned as unknown — it is print-only JSON,
// not a typed contract.
export function batchJson(batchDir: string): unknown {
  const header: unknown = JSON.parse(
    readFileSync(join(batchDir, 'batch.json'), 'utf8'),
  );
  const results: unknown[] = [];
  const text = readFileSync(join(batchDir, 'results.jsonl'), 'utf8');
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    results.push(JSON.parse(line));
  }
  if (header !== null && typeof header === 'object') {
    return { ...header, results };
  }
  return { results };
}
