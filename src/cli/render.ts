import { z } from 'zod';
import type { FinalVerdict } from '../contracts/verdict.ts';

export type ShowMode = 'full' | 'quiet' | 'json';

export interface RenderOptions {
  readonly color: boolean;
  readonly mode: ShowMode;
}

type Rgb = readonly [number, number, number];

// Verdict renderer for `quorum show`. The NO-COLOR text layout is the stable
// contract (it was kept byte-identical to the original Python `show` output);
// color is TTY-only and best-effort.

const FOOTER =
  'see docs/superpowers/skills/triaging-a-failing-eval.md for triage.';

// Dracula verdict palette (truecolor, bypasses theme remapping). Mirrors
// _VERDICT_COLORS; pass/fail/indeterminate only — other statuses get no color.
function verdictColor(status: string): Rgb | undefined {
  switch (status) {
    case 'pass':
      return [80, 250, 123];
    case 'fail':
      return [255, 85, 85];
    case 'indeterminate':
      return [241, 250, 140];
    default:
      return undefined;
  }
}

const LABEL_RGB: Rgb = [122, 130, 148];

type NamedColor =
  | 'bright_cyan'
  | 'bright_blue'
  | 'bright_magenta'
  | 'red'
  | 'bright_black';
const NAMED_FG: Record<NamedColor, number> = {
  bright_cyan: 96,
  bright_blue: 94,
  bright_magenta: 95,
  red: 31,
  bright_black: 90,
};

interface StyleOpts {
  readonly fg?: Rgb | NamedColor | undefined;
  readonly bold?: boolean;
  readonly dim?: boolean;
}

// click.style equivalent: apply ANSI only when color is on, else passthrough
// (the no-color path is what the differential pins). fg is a 24-bit RGB tuple or
// a named color.
function style(text: string, opts: StyleOpts, color: boolean): string {
  if (!color) {
    return text;
  }
  const codes: string[] = [];
  if (opts.bold) {
    codes.push('1');
  }
  if (opts.dim) {
    codes.push('2');
  }
  if (opts.fg !== undefined) {
    if (typeof opts.fg === 'string') {
      codes.push(String(NAMED_FG[opts.fg]));
    } else {
      const [r, g, b] = opts.fg;
      codes.push(`38;2;${r};${g};${b}`);
    }
  }
  if (codes.length === 0) {
    return text;
  }
  return `\x1b[${codes.join(';')}m${text}\x1b[0m`;
}

function label(text: string, color: boolean): string {
  return style(text, { fg: LABEL_RGB }, color);
}

// ---------- formatting helpers (quorum/show.py _fmt_*) -------------------

// The _fmt_* helpers take `unknown` and degrade per-field on an off-type value
// (parity with show.py, where _fmt_cost/_fmt_tokens/_fmt_bytes use isinstance
// and return 'n/a'/'—' rather than crashing). This keeps a single off-type
// economics field from dropping the whole pane.
function fmtMs(ms: unknown): string {
  if (typeof ms !== 'number' || ms === 0 || Number.isNaN(ms)) {
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

function fmtCost(c: unknown): string {
  return typeof c === 'number' ? `$${c.toFixed(2)}` : 'n/a';
}

function fmtTokens(n: unknown): string {
  if (typeof n !== 'number' || n === 0) {
    return '—';
  }
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : `${(n / 1_000).toFixed(0)}K`;
}

function fmtBytes(n: unknown): string {
  if (typeof n !== 'number' || n === 0) {
    return '—';
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}MB`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(0)}KB`;
  }
  return `${Math.trunc(n)}B`;
}

function shortModel(modelId: unknown): string {
  if (typeof modelId !== 'string') {
    return '—';
  }
  const m = modelId.toLowerCase();
  for (const fam of ['opus', 'sonnet', 'haiku']) {
    if (m.includes(fam)) {
      return fam;
    }
  }
  if (m.includes('gpt') || m.includes('codex')) {
    return 'gpt';
  }
  return modelId;
}

// Word-wrap prose to `width` cols, indenting continuation lines by `indent`
// spaces. A plain greedy wrap — readable and semantically faithful to the Python
// renderer; exact word-wrap parity (Python's textwrap break-on-hyphens /
// long-word splitting) is explicitly NOT a goal. Formatting may differ on
// hyphenated or over-long tokens; the content does not.
function wrapIndent(text: string, indent: number, width: number): string {
  if (!text) {
    return '';
  }
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) {
    return '';
  }
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const lead = lines.length === 0 ? 0 : indent;
    if (cur === '') {
      cur = word;
    } else if (lead + cur.length + 1 + word.length <= width) {
      cur += ` ${word}`;
    } else {
      lines.push((lines.length === 0 ? '' : pad) + cur);
      cur = word;
    }
  }
  lines.push((lines.length === 0 ? '' : pad) + cur);
  return lines.join('\n');
}

// ---------- economics pane (quorum/show.py _format_economics_pane) -------

// The economics view schemas are deliberately TOLERANT: every leaf field is
// `unknown` so safeParse succeeds for any economics shape. The renderer mirrors
// show.py, whose only gate is `if not econ` — off-type fields degrade per-cell
// via the _fmt_* helpers rather than dropping the whole pane.
const ObolViewSchema = z
  .object({
    pricing_as_of: z.unknown(),
    approximations: z
      .array(z.object({ kind: z.unknown() }).passthrough())
      .nullish(),
  })
  .passthrough();
const TokensViewSchema = z.object({ total: z.unknown() }).passthrough();
const ModelViewSchema = z
  .object({
    model: z.unknown(),
    tokens: TokensViewSchema.nullish(),
    est_cost_usd: z.unknown(),
  })
  .passthrough();
const BlockViewSchema = z
  .object({
    duration_ms: z.unknown(),
    tokens: TokensViewSchema.nullish(),
    est_cost_usd: z.unknown(),
    model: z.unknown(),
    models: z.array(ModelViewSchema).nullish(),
    tool_result_total_bytes: z.unknown(),
    obol: ObolViewSchema.nullish(),
  })
  .passthrough();
const EconViewSchema = z
  .object({
    gauntlet: BlockViewSchema.nullish(),
    coding_agent: BlockViewSchema.nullish(),
    total_est_cost_usd: z.unknown(),
    partial: z.unknown(),
  })
  .passthrough();
type BlockView = z.infer<typeof BlockViewSchema>;

function agentRow(
  rowLabel: string,
  block: BlockView | null | undefined,
): string {
  if (!block) {
    return `  ${rowLabel.padEnd(10)} ${'—'.padStart(10)} ${'—'.padStart(9)} ${'—'.padStart(9)}`;
  }
  const dur = fmtMs(block.duration_ms);
  const tok = fmtTokens(block.tokens?.total);
  let cost = fmtCost(block.est_cost_usd);
  if (
    (block.est_cost_usd === null || block.est_cost_usd === undefined) &&
    block.model
  ) {
    cost = `n/a (${block.model})`;
  }
  return `  ${rowLabel.padEnd(10)} ${dur.padStart(10)} ${tok.padStart(9)} ${cost.padStart(9)}`;
}

function modelSubrow(entry: z.infer<typeof ModelViewSchema>): string {
  const rowLabel = `  ${shortModel(entry.model)}`;
  const tok = fmtTokens(entry.tokens?.total);
  let cost = fmtCost(entry.est_cost_usd);
  if (
    (entry.est_cost_usd === null || entry.est_cost_usd === undefined) &&
    entry.model
  ) {
    cost = 'n/a';
  }
  return `  ${rowLabel.padEnd(10)} ${''.padStart(10)} ${tok.padStart(9)} ${cost.padStart(9)}`;
}

function formatEconomicsPane(
  econRaw: Readonly<Record<string, unknown>> | null,
  color: boolean,
): string {
  if (econRaw === null || Object.keys(econRaw).length === 0) {
    return '';
  }
  const parsed = EconViewSchema.safeParse(econRaw);
  if (!parsed.success) {
    return '';
  }
  const econ = parsed.data;
  const sep = style(
    '─── Economics ────────────────────────────────────',
    { fg: 'bright_cyan', bold: true },
    color,
  );
  const header = `  ${''.padEnd(10)} ${'duration'.padStart(10)} ${'tokens'.padStart(9)} ${'est cost'.padStart(9)}`;
  const coding = econ.coding_agent;
  const rows: string[] = [
    agentRow('Gauntlet', econ.gauntlet),
    agentRow('Coding', coding),
  ];
  for (const entry of coding?.models ?? []) {
    rows.push(modelSubrow(entry));
  }
  const trBytes = coding?.tool_result_total_bytes;
  if (trBytes) {
    rows.push(
      `  ${'tool bytes'.padEnd(10)} ${''.padStart(10)} ${fmtBytes(trBytes).padStart(9)} ${''.padStart(9)}`,
    );
  }
  const total = econ.total_est_cost_usd;
  const totalStr =
    total !== null && total !== undefined
      ? fmtCost(total)
      : econ.partial
        ? 'partial'
        : '—';
  rows.push(
    `  ${'total'.padEnd(10)} ${''.padStart(10)} ${''.padStart(9)} ${totalStr.padStart(9)}`,
  );
  const prov = coding?.obol ?? econ.gauntlet?.obol;
  if (prov?.pricing_as_of) {
    let note = `pricing: as of ${prov.pricing_as_of}`;
    const kinds: string[] = [];
    for (const block of [coding, econ.gauntlet]) {
      for (const a of block?.obol?.approximations ?? []) {
        const kind = a.kind;
        if (typeof kind === 'string' && kind && !kinds.includes(kind)) {
          kinds.push(kind);
        }
      }
    }
    if (kinds.length > 0) {
      note += ` · ${kinds.join(', ')}`;
    }
    rows.push(style(`  ${note}`, { fg: 'bright_black' }, color));
  }
  return `${[sep, header, ...rows].join('\n')}\n`;
}

// ---------- panes (quorum/show.py _format_*) ----------------------------

function formatHeader(
  verdict: FinalVerdict,
  runDir: string,
  color: boolean,
): string {
  const finalStyled = style(
    verdict.final,
    { fg: verdictColor(verdict.final), bold: true },
    color,
  );
  return (
    `${label('run-dir  ', color)} ${runDir}\n` +
    `${label('final    ', color)} ${finalStyled}\n` +
    `${label('reason   ', color)} ${verdict.final_reason}\n`
  );
}

function formatGauntletPane(verdict: FinalVerdict, color: boolean): string {
  const g = verdict.gauntlet;
  const status = g?.status ?? '—';
  const statusStyled = style(
    status,
    { fg: verdictColor(status), bold: true },
    color,
  );
  const summary = wrapIndent(g?.summary ?? '', 10, 72);
  const reasoning = wrapIndent(g?.reasoning ?? '', 10, 72);
  const sep = style(
    '─── Gauntlet-Agent ───────────────────────────────',
    { fg: 'bright_cyan', bold: true },
    color,
  );
  return (
    `${sep}\n` +
    `${label('status   ', color)} ${statusStyled}\n` +
    `${label('summary  ', color)} ${summary}\n` +
    `${label('reasoning', color)} ${reasoning}\n`
  );
}

function formatChecksPane(verdict: FinalVerdict, color: boolean): string {
  const sep = style(
    '─── Deterministic checks ─────────────────────────',
    { fg: 'bright_cyan', bold: true },
    color,
  );
  const lines: string[] = [sep];
  for (const phase of ['pre', 'post'] as const) {
    const phaseStyled = style(phase.padEnd(4), { fg: 'bright_blue' }, color);
    for (const c of verdict.checks) {
      if (c.phase !== phase) {
        continue;
      }
      const markChar = c.passed ? '✓' : '✗';
      const mark = style(
        markChar,
        { fg: verdictColor(c.passed ? 'pass' : 'fail'), bold: true },
        color,
      );
      const negated = c.negated
        ? style('NOT ', { fg: 'bright_magenta', bold: true }, color)
        : '';
      const args = c.args.join(' ');
      let head = `${phaseStyled} ${mark} ${negated}${c.check}`;
      if (args) {
        head += ` ${args}`;
      }
      lines.push(head);
      if (!c.passed && c.detail) {
        lines.push(style(`       ↳ ${c.detail}`, { fg: 'red' }, color));
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export function render(
  verdict: FinalVerdict,
  runDir: string,
  opts: RenderOptions,
): string {
  if (opts.mode === 'json') {
    return `${JSON.stringify(verdict, null, 2)}\n`;
  }
  if (opts.mode === 'quiet') {
    // Quiet is for pipelines — never color.
    return `final     ${verdict.final}\nreason    ${verdict.final_reason}\n`;
  }

  const parts = [
    formatHeader(verdict, runDir, opts.color),
    formatGauntletPane(verdict, opts.color),
    formatChecksPane(verdict, opts.color),
    formatEconomicsPane(verdict.economics, opts.color),
    `${FOOTER}\n`,
  ];
  return parts.filter((p) => p).join('\n');
}
