// quorum/show.ts — TypeScript port of quorum/show.py (build-ahead, phase B).
//
// Neutral renderer over verdict.json + siblings. Mirrors the Python public
// API and reproduces its ANSI escape sequences, glyphs, column widths, and
// number/byte/cost/token formatting byte-for-byte.
//
// The Python renderer styles via click.style (full-mode panes) and rich
// (batch matrix). Both are reproduced directly here:
//   - click.style emits: <fg?><bold-code><dim-code>TEXT\x1b[0m, where the
//     bold/dim codes are always present because show.py always passes the
//     dim= and bold= keyword arguments (defaulting to False -> reset code 22).
//   - rich emits markup [rgb(r,g,b)]text[/] as \x1b[38;2;r;g;bmtext\x1b[0m
//     in truecolor mode, and strips markup to plain text otherwise.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export type ShowMode = "full" | "quiet" | "json";

export class ShowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShowError";
  }
}

// ---------- resolver ----------------------------------------------------

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A path is a batch dir if it contains batch.json. */
export function isBatchDir(path: string): boolean {
  return isDir(path) && existsSync(join(path, "batch.json"));
}

function verdictMtime(dir: string): number {
  return statSync(join(dir, "verdict.json")).mtimeMs;
}

/**
 * Resolve `<target>` (per spec §5) to a run-dir or batch-dir path.
 *
 * Order:
 *   1. undefined → newest run-dir under resultsRoot (by verdict.json mtime).
 *   2a. Path that is a batch dir (contains batch.json) → that dir.
 *   2. Path that is a dir with verdict.json → that dir.
 *   3. Path that is a verdict.json file → its parent dir.
 *   4a. Batch ID under resultsRoot/batches/<target>/ → that batch dir.
 *   4. Prefix match under resultsRoot: `<target>-*` → newest match by mtime.
 *   5. Else → ShowError.
 */
export function resolveTarget(target: string | undefined, resultsRoot: string): string {
  // Rule 1: omitted
  if (target === undefined) {
    if (!isDir(resultsRoot)) {
      throw new ShowError(
        `no run-dir resolved from <none> (results root does not exist: ${resultsRoot})`,
      );
    }
    const candidates = readdirSync(resultsRoot)
      .map((name) => join(resultsRoot, name))
      .filter((d) => isDir(d) && isFile(join(d, "verdict.json")));
    if (candidates.length === 0) {
      throw new ShowError(`no run-dir resolved from <none> (no runs in ${resultsRoot})`);
    }
    return maxByMtime(candidates);
  }

  const p = target;

  // Batch dir (explicit path) — must precede the run-dir check, which
  // would otherwise raise "no verdict.json in <p>" for a batch path.
  if (isDir(p) && isBatchDir(p)) {
    return p;
  }

  // Rule 2: directory containing verdict.json
  if (isDir(p)) {
    if (isFile(join(p, "verdict.json"))) {
      return p;
    }
    throw new ShowError(`no verdict.json in ${p}`);
  }

  // Rule 3: verdict.json file itself
  if (isFile(p) && basename(p) === "verdict.json") {
    return dirname(p);
  }

  // Rule 4: prefix match under resultsRoot. An absolute path that didn't
  // match rules 2-3 cannot be a valid run-dir prefix.
  if (isAbsolute(p)) {
    throw new ShowError(`no run-dir resolved from ${reprStr(target)}`);
  }
  if (!isDir(resultsRoot)) {
    throw new ShowError(
      `no run-dir resolved from ${reprStr(target)} (results root does not exist: ${resultsRoot})`,
    );
  }
  // Batch ID lookup: resultsRoot/batches/<target>/.
  const batchCandidate = join(resultsRoot, "batches", target);
  if (isBatchDir(batchCandidate)) {
    return batchCandidate;
  }
  const matches = readdirSync(resultsRoot)
    .filter((name) => name.startsWith(`${target}-`))
    .map((name) => join(resultsRoot, name))
    .filter((d) => isDir(d) && isFile(join(d, "verdict.json")));
  if (matches.length > 0) {
    return maxByMtime(matches);
  }

  // Rule 5: nothing matched
  throw new ShowError(`no run-dir resolved from ${reprStr(target)}`);
}

function maxByMtime(dirs: string[]): string {
  let best = dirs[0]!;
  let bestM = verdictMtime(best);
  for (const d of dirs.slice(1)) {
    const m = verdictMtime(d);
    if (m > bestM) {
      best = d;
      bestM = m;
    }
  }
  return best;
}

/** Mirror Python's repr() for a plain string in error messages: 'text'. */
function reprStr(s: string): string {
  if (s.includes("'") && !s.includes('"')) {
    return `"${s}"`;
  }
  return `'${s.replace(/'/g, "\\'")}'`;
}

// ---------- formatting helpers ------------------------------------------

const FOOTER = "see docs/superpowers/skills/triaging-a-failing-eval.md for triage.";

// Verdict colors as 24-bit RGB tuples (Dracula palette).
const VERDICT_COLORS: Record<string, [number, number, number]> = {
  pass: [80, 250, 123],
  fail: [255, 85, 85],
  indeterminate: [241, 250, 140],
};

const LABEL_RGB: [number, number, number] = [122, 130, 148];

// Matrix-view glyph colors (rich markup color names).
const BATCH_GLYPH_COLORS: Record<string, string> = {
  pass: "rgb(80,250,123)",
  fail: "rgb(255,85,85)",
  indeterminate: "rgb(241,250,140)",
  skipped: "rgb(122,130,148)",
  unknown: "rgb(122,130,148)",
};

const ANSI_COLORS: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  reset: 39,
  bright_black: 90,
  bright_red: 91,
  bright_green: 92,
  bright_yellow: 93,
  bright_blue: 94,
  bright_magenta: 95,
  bright_cyan: 96,
  bright_white: 97,
};

type Fg = string | [number, number, number] | null | undefined;

function interpretColor(fg: string | [number, number, number]): string {
  if (typeof fg === "string") {
    const code = ANSI_COLORS[fg];
    if (code === undefined) {
      throw new TypeError(`Unknown color ${fg}`);
    }
    return String(code);
  }
  return `38;2;${fg[0]};${fg[1]};${fg[2]}`;
}

/**
 * Apply click.style only when color=true; passthrough otherwise.
 *
 * show.py always passes dim and bold (defaulting to False), so click always
 * emits the corresponding reset codes (22). Reproduces:
 *   <fg?>\x1b[<1|22>m\x1b[<2|22>mTEXT\x1b[0m
 */
function style(
  text: string,
  opts: { fg?: Fg; dim?: boolean; bold?: boolean; color: boolean },
): string {
  if (!opts.color) {
    return text;
  }
  const dim = opts.dim ?? false;
  const bold = opts.bold ?? false;
  let bits = "";
  // click: `if fg:` — falsy fg (null/undefined) is skipped.
  if (opts.fg !== null && opts.fg !== undefined) {
    bits += `\x1b[${interpretColor(opts.fg)}m`;
  }
  // bold and dim are always provided (not None) -> always emitted.
  bits += `\x1b[${bold ? 1 : 22}m`;
  bits += `\x1b[${dim ? 2 : 22}m`;
  return `${bits}${text}\x1b[0m`;
}

/**
 * Python str.format fixed-precision: round-half-to-even on the double value.
 * JS toFixed rounds half away from zero, which diverges from CPython for
 * exact-half cases (e.g. 0.125 -> "0.12" in Python, "0.13" in JS).
 */
function pyFixed(x: number, ndigits: number): string {
  if (!Number.isFinite(x)) {
    return x.toString();
  }
  const neg = x < 0;
  const ax = Math.abs(x);
  // Exact decimal digits of the double, with generous precision so the
  // rounding boundary is decided on the true value, not a pre-rounded one.
  const exact = ax.toFixed(Math.min(ndigits + 25, 100));
  const dot = exact.indexOf(".");
  const intPart = exact.slice(0, dot);
  const fracPart = exact.slice(dot + 1);
  const keep = fracPart.slice(0, ndigits);
  const rest = fracPart.slice(ndigits);
  const digits = (intPart + keep).split("");
  const roundUp = decideRoundHalfEven(rest, digits[digits.length - 1] ?? "0");
  if (roundUp) {
    incrementDigits(digits);
  }
  const combined = digits.join("");
  const fracLen = ndigits;
  const intLen = combined.length - fracLen;
  const intStr = combined.slice(0, intLen) || "0";
  const fracStr = combined.slice(intLen);
  const sign = neg && /[1-9]/.test(combined) ? "-" : "";
  return ndigits > 0 ? `${sign}${intStr}.${fracStr}` : `${sign}${intStr}`;
}

function decideRoundHalfEven(rest: string, lastKeptDigit: string): boolean {
  if (rest.length === 0) {
    return false;
  }
  const first = rest[0]!;
  if (first < "5") {
    return false;
  }
  if (first > "5") {
    return true;
  }
  // first === "5": check for any nonzero remainder beyond it.
  if (/[1-9]/.test(rest.slice(1))) {
    return true;
  }
  // exact half -> round to even.
  return (Number(lastKeptDigit) & 1) === 1;
}

function incrementDigits(digits: string[]): void {
  let i = digits.length - 1;
  while (i >= 0) {
    if (digits[i] === "9") {
      digits[i] = "0";
      i -= 1;
    } else {
      digits[i] = String(Number(digits[i]) + 1);
      return;
    }
  }
  digits.unshift("1");
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && !Number.isNaN(v);
}

export function _fmtMs(ms: unknown): string {
  if (!ms || !isNum(ms)) {
    return "—";
  }
  const s = Math.trunc(ms / 1000);
  const h = Math.trunc(s / 3600);
  const rem = s - h * 3600;
  const m = Math.trunc(rem / 60);
  const sec = rem - m * 60;
  return h ? `${h}h ${pad2(m)}m` : `${m}m ${pad2(sec)}s`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function _fmtCost(c: unknown): string {
  return isNum(c) ? `$${pyFixed(c, 2)}` : "n/a";
}

export function _fmtTokens(n: unknown): string {
  if (!isNum(n) || n === 0) {
    return "—";
  }
  return n >= 1_000_000 ? `${pyFixed(n / 1_000_000, 1)}M` : `${pyFixed(n / 1_000, 0)}K`;
}

export function _fmtBytes(n: unknown): string {
  if (!isNum(n) || n === 0) {
    return "—";
  }
  if (n >= 1_000_000) {
    return `${pyFixed(n / 1_000_000, 1)}MB`;
  }
  if (n >= 1_000) {
    return `${pyFixed(n / 1_000, 0)}KB`;
  }
  return `${Math.trunc(n)}B`;
}

export function _shortModel(modelId: unknown): string {
  if (typeof modelId !== "string") {
    return "—";
  }
  const m = modelId.toLowerCase();
  for (const fam of ["opus", "sonnet", "haiku"]) {
    if (m.includes(fam)) {
      return fam;
    }
  }
  if (m.includes("gpt") || m.includes("codex")) {
    return "gpt";
  }
  return modelId;
}

// String padding by code-point count (matches Python str width semantics for
// the BMP glyphs used here). Python f-string {:<N}/{:>N} count code points.
function ljust(s: string, width: number): string {
  const len = [...s].length;
  return len >= width ? s : s + " ".repeat(width - len);
}

function rjust(s: string, width: number): string {
  const len = [...s].length;
  return len >= width ? s : " ".repeat(width - len) + s;
}

type Block = Record<string, unknown> | null | undefined;

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function agentRow(label: string, block: Block): string {
  if (!block) {
    return `  ${ljust(label, 10)} ${rjust("—", 10)} ${rjust("—", 9)} ${rjust("—", 9)}`;
  }
  const dur = _fmtMs(block["duration_ms"]);
  const tok = _fmtTokens(asObj(block["tokens"])["total"]);
  let cost = _fmtCost(block["est_cost_usd"]);
  if ((block["est_cost_usd"] === null || block["est_cost_usd"] === undefined) && block["model"]) {
    cost = `n/a (${block["model"]})`;
  }
  return `  ${ljust(label, 10)} ${rjust(dur, 10)} ${rjust(tok, 9)} ${rjust(cost, 9)}`;
}

export function _modelSubrow(entry: Record<string, unknown>): string {
  const label = "  " + _shortModel(entry["model"]);
  const tok = _fmtTokens(asObj(entry["tokens"])["total"]);
  let cost = _fmtCost(entry["est_cost_usd"]);
  if ((entry["est_cost_usd"] === null || entry["est_cost_usd"] === undefined) && entry["model"]) {
    cost = "n/a";
  }
  return `  ${ljust(label, 10)} ${rjust("", 10)} ${rjust(tok, 9)} ${rjust(cost, 9)}`;
}

export function _formatEconomicsPane(verdict: Record<string, unknown>, color: boolean): string {
  if (!verdict["economics"]) {
    return "";
  }
  const econ = asObj(verdict["economics"]);
  if (Object.keys(econ).length === 0) {
    return "";
  }
  const sep = style("─── Economics ────────────────────────────────────", {
    fg: "bright_cyan",
    bold: true,
    color,
  });
  const header = `  ${ljust("", 10)} ${rjust("duration", 10)} ${rjust("tokens", 9)} ${rjust("est cost", 9)}`;
  const rows: string[] = [agentRow("Gauntlet", econ["gauntlet"] as Block)];
  const coding = econ["coding_agent"] as Block;
  rows.push(agentRow("Coding", coding));
  const models = (asObj(coding)["models"] as unknown[]) || [];
  for (const entry of models) {
    rows.push(_modelSubrow(asObj(entry)));
  }
  const trBytes = asObj(coding)["tool_result_total_bytes"];
  if (trBytes) {
    rows.push(
      `  ${ljust("tool bytes", 10)} ${rjust("", 10)} ${rjust(_fmtBytes(trBytes), 9)} ${rjust("", 9)}`,
    );
  }
  const total = econ["total_est_cost_usd"];
  const totalStr =
    total !== null && total !== undefined ? _fmtCost(total) : econ["partial"] ? "partial" : "—";
  rows.push(`  ${ljust("total", 10)} ${rjust("", 10)} ${rjust("", 9)} ${rjust(totalStr, 9)}`);

  // Pricing provenance footnote: which snapshot priced this run, plus any
  // approximations obol applied. Pre-obol verdicts have no nested obol blocks.
  const codingObol = asObj(asObj(econ["coding_agent"])["obol"]);
  const gauntletObol = asObj(asObj(econ["gauntlet"])["obol"]);
  const prov =
    Object.keys(codingObol).length > 0
      ? codingObol
      : Object.keys(gauntletObol).length > 0
        ? gauntletObol
        : null;
  if (prov && prov["pricing_as_of"]) {
    let note = `pricing: as of ${prov["pricing_as_of"]}`;
    const kinds: string[] = [];
    for (const blockKey of ["coding_agent", "gauntlet"]) {
      const approx = (asObj(asObj(econ[blockKey])["obol"])["approximations"] as unknown[]) || [];
      for (const a of approx) {
        const kind = asObj(a)["kind"];
        if (kind && typeof kind === "string" && !kinds.includes(kind)) {
          kinds.push(kind);
        }
      }
    }
    if (kinds.length > 0) {
      note += " · " + kinds.join(", ");
    }
    rows.push(style(`  ${note}`, { fg: "bright_black", color }));
  }
  return [sep, header, ...rows].join("\n") + "\n";
}

function label(text: string, color: boolean): string {
  return style(text, { fg: LABEL_RGB, color });
}

function formatHeader(verdict: Record<string, unknown>, runDir: string, color: boolean): string {
  const final = verdict["final"] as string;
  const reason = (verdict["final_reason"] as string) ?? "";
  const finalStyled = style(final, {
    fg: VERDICT_COLORS[final] ?? null,
    bold: true,
    color,
  });
  return (
    `${label("run-dir  ", color)} ${runDir}\n` +
    `${label("final    ", color)} ${finalStyled}\n` +
    `${label("reason   ", color)} ${reason}\n`
  );
}

function formatGauntletPane(verdict: Record<string, unknown>, color: boolean): string {
  const g = asObj(verdict["gauntlet"]);
  const status = (g["status"] as string) || "—";
  const statusStyled = style(status, {
    fg: VERDICT_COLORS[status] ?? null,
    bold: true,
    color,
  });
  const summary = wrapIndent((g["summary"] as string) ?? "", 10, 72);
  const reasoning = wrapIndent((g["reasoning"] as string) ?? "", 10, 72);
  const sep = style("─── Gauntlet-Agent ───────────────────────────────", {
    fg: "bright_cyan",
    bold: true,
    color,
  });
  return (
    `${sep}\n` +
    `${label("status   ", color)} ${statusStyled}\n` +
    `${label("summary  ", color)} ${summary}\n` +
    `${label("reasoning", color)} ${reasoning}\n`
  );
}

function formatChecksPane(verdict: Record<string, unknown>, color: boolean): string {
  const checks = (verdict["checks"] as Record<string, unknown>[]) || [];
  const sep = style("─── Deterministic checks ─────────────────────────", {
    fg: "bright_cyan",
    bold: true,
    color,
  });
  const lines: string[] = [sep];
  for (const phase of ["pre", "post"]) {
    const phaseStyled = style(ljust(phase, 4), { fg: "bright_blue", color });
    for (const c of checks) {
      if (c["phase"] !== phase) {
        continue;
      }
      const passed = c["passed"];
      const markChar = passed ? "✓" : "✗";
      const mark = style(markChar, {
        fg: VERDICT_COLORS[passed ? "pass" : "fail"]!,
        bold: true,
        color,
      });
      const negated = c["negated"]
        ? style("NOT ", { fg: "bright_magenta", bold: true, color })
        : "";
      const args = ((c["args"] as string[]) || []).join(" ");
      let head = `${phaseStyled} ${mark} ${negated}${c["check"]}`;
      if (args) {
        head += ` ${args}`;
      }
      lines.push(head);
      if (!passed && c["detail"]) {
        lines.push(style(`       ↳ ${c["detail"]}`, { fg: "red", color }));
      }
    }
  }
  return lines.join("\n") + "\n";
}

/** Word-wrap text to width cols, indenting all but the first line. */
function wrapIndent(text: string, indent: number, width: number): string {
  if (!text) {
    return "";
  }
  return textwrapFill(text, width, " ".repeat(indent));
}

/**
 * Faithful port of Python textwrap.fill with default options:
 *   replace_whitespace=True, drop_whitespace=True, break_long_words=True,
 *   break_on_hyphens=True, subsequent_indent=pad.
 *
 * Whitespace is collapsed to single spaces; text is greedily packed into
 * lines no wider than `width`, with `subsequentIndent` prefixed to every
 * line after the first.
 */
function textwrapFill(text: string, width: number, subsequentIndent: string): string {
  const normalized = text.replace(/[\t\n\x0b\f\r]/g, " ");
  const chunks = splitChunks(normalized);
  const lines = wrapChunks(chunks, width, subsequentIndent);
  return lines.join("\n");
}

// Split into chunks: runs of whitespace become single-space chunks; words
// split after hyphens (break_on_hyphens=True approximation).
function splitChunks(text: string): string[] {
  const raw: string[] = [];
  for (const part of text.split(/(\s+)/)) {
    if (part === "") {
      continue;
    }
    if (/^\s+$/.test(part)) {
      raw.push(" ");
    } else {
      raw.push(...splitOnHyphens(part));
    }
  }
  return raw;
}

function splitOnHyphens(word: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < word.length; i++) {
    current += word[i];
    if (
      word[i] === "-" &&
      i > 0 &&
      i + 1 < word.length &&
      /[A-Za-z]/.test(word[i - 1]!) &&
      /[A-Za-z]/.test(word[i + 1]!)
    ) {
      out.push(current);
      current = "";
    }
  }
  if (current) {
    out.push(current);
  }
  return out.length ? out : [word];
}

function wrapChunks(chunksIn: string[], width: number, subsequentIndent: string): string[] {
  const chunks = chunksIn.slice();
  const lines: string[] = [];
  while (chunks.length > 0) {
    const curLine: string[] = [];
    let curLen = 0;
    const indent = lines.length > 0 ? subsequentIndent : "";
    const w = width - indent.length;

    // drop_whitespace: drop leading whitespace on lines after the first.
    if (chunks[0]!.trim() === "" && lines.length > 0) {
      chunks.shift();
    }

    while (chunks.length > 0) {
      const l = [...chunks[0]!].length;
      if (curLen + l <= w) {
        curLine.push(chunks.shift()!);
        curLen += l;
      } else {
        break;
      }
    }

    // break_long_words: a chunk too big for an empty line gets force-split.
    if (chunks.length > 0 && [...chunks[0]!].length > w) {
      handleLongWord(chunks, curLine, curLen, w);
      curLen = curLine.reduce((acc, c) => acc + [...c].length, 0);
    }

    // drop_whitespace: drop trailing whitespace.
    if (curLine.length > 0 && curLine[curLine.length - 1]!.trim() === "") {
      curLen -= [...curLine[curLine.length - 1]!].length;
      curLine.pop();
    }

    if (curLine.length > 0) {
      lines.push(indent + curLine.join(""));
    } else if (chunks.length > 0) {
      // Avoid an infinite loop if nothing fit and nothing could be split.
      lines.push(indent + chunks.shift()!);
    }
  }
  return lines;
}

function handleLongWord(chunks: string[], curLine: string[], curLen: number, width: number): void {
  const spaceLeft = width < 1 ? 1 : width - curLen;
  const chunk = chunks[0]!;
  const cps = [...chunk];
  let end = spaceLeft;
  if (end < 1 && curLine.length === 0) {
    end = 1;
  }
  if (end >= 1) {
    curLine.push(cps.slice(0, end).join(""));
    chunks[0] = cps.slice(end).join("");
  } else if (curLine.length === 0) {
    curLine.push(chunks.shift()!);
  }
}

export function render(
  verdict: Record<string, unknown>,
  runDir: string,
  opts: { color: boolean; mode: ShowMode },
): string {
  const { color, mode } = opts;
  if (mode === "json") {
    return JSON.stringify(verdict, null, 2) + "\n";
  }
  if (mode === "quiet") {
    // Quiet mode is for pipelines — never color, regardless of flag.
    return `final     ${verdict["final"]}\nreason    ${verdict["final_reason"] ?? ""}\n`;
  }
  // mode === "full"
  const parts = [
    formatHeader(verdict, runDir, color),
    formatGauntletPane(verdict, color),
    formatChecksPane(verdict, color),
    _formatEconomicsPane(verdict, color),
    FOOTER + "\n",
  ];
  return parts.filter((p) => p).join("\n");
}

// ---------- batch matrix renderer --------------------------------------

const GLYPHS: Record<string, [string, string]> = {
  pass: ["✓", "pass"],
  fail: ["✗", "fail"],
  indeterminate: ["⊘", "indet"],
  skipped: ["—", "skip"],
  unknown: ["?", "?"],
};

export function renderBatch(opts: {
  batchDir: string;
  resultsRoot: string;
  color: boolean;
}): string {
  const { batchDir, resultsRoot, color } = opts;
  const batch = JSON.parse(readFileSync(join(batchDir, "batch.json"), "utf8"));
  const rows = readFileSync(join(batchDir, "results.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  const agents = batch["coding_agents"] as string[];
  const scenarios = [...new Set(rows.map((r) => r["scenario"] as string))].sort();

  // Store verdict keys (not pre-rendered) so styling applies per cell.
  const cellVerdicts = new Map<string, string>();
  const counts: Record<string, number> = {
    pass: 0,
    fail: 0,
    indeterminate: 0,
    skipped: 0,
    unknown: 0,
  };
  const cellKey = (s: string, a: string) => `${s} ${a}`;
  for (const r of rows) {
    const key = cellKey(r["scenario"] as string, r["coding_agent"] as string);
    if (r["skipped"]) {
      cellVerdicts.set(key, "skipped");
      counts["skipped"] = (counts["skipped"] ?? 0) + 1;
      continue;
    }
    const runId = r["run_id"] as string | null | undefined;
    const verdictPath = runId ? join(resultsRoot, runId, "verdict.json") : null;
    if (!verdictPath || !existsSync(verdictPath)) {
      cellVerdicts.set(key, "unknown");
      counts["unknown"] = (counts["unknown"] ?? 0) + 1;
      continue;
    }
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(readFileSync(verdictPath, "utf8"));
    } catch {
      cellVerdicts.set(key, "unknown");
      counts["unknown"] = (counts["unknown"] ?? 0) + 1;
      continue;
    }
    let final = (v["final"] as string) ?? "unknown";
    if (!(final in GLYPHS)) {
      final = "unknown";
    }
    cellVerdicts.set(key, final);
    counts[final] = (counts[final] ?? 0) + 1;
  }

  // Column widths grow to fit content.
  let scenW = scenarios.length ? Math.max(...scenarios.map((s) => [...s].length)) : 8;
  scenW = Math.max(scenW, "scenario".length);
  const cellW = Math.max(...agents.map((a) => [...a].length), [..."⊘ indet"].length);

  const sep =
    "|" + "-".repeat(scenW + 2) + "|" + agents.map(() => "-".repeat(cellW + 2)).join("|") + "|";
  const header =
    "| " + ljust("scenario", scenW) + " | " + agents.map((a) => ljust(a, cellW)).join(" | ") + " |";

  const out: string[] = [];
  const emit = (line: string) => out.push(line + "\n");

  const banner =
    `batch ${batch["id"]} · started ${batch["started_at"]}` +
    (batch["finished_at"] ? ` · finished ${batch["finished_at"]}` : "");
  emit(banner);
  emit("");
  emit(header);
  emit(sep);
  for (const s of scenarios) {
    const rowCells: string[] = [];
    for (const a of agents) {
      const verdict = cellVerdicts.get(cellKey(s, a)) ?? "unknown";
      const [glyph, lbl] = GLYPHS[verdict]!;
      const text = ljust(`${glyph} ${lbl}`, cellW);
      const colorName = BATCH_GLYPH_COLORS[verdict]!;
      rowCells.push(richMarkup(text, colorName, color));
    }
    emit("| " + ljust(s, scenW) + " | " + rowCells.join(" | ") + " |");
  }
  emit("");
  emit("Legend: ✓ pass   ✗ fail   ⊘ indeterminate   — skipped (directive)   ? no verdict");
  const tally =
    `${counts["pass"]} ✓ · ${counts["fail"]} ✗ · ` +
    `${counts["indeterminate"]} ⊘ · ${counts["skipped"]} —` +
    (counts["unknown"] ? ` · ${counts["unknown"]} ?` : "");
  emit(tally);
  return out.join("");
}

/**
 * Reproduce rich's rendering of [<color>]text[/] markup:
 *   - truecolor (color=true): \x1b[38;2;r;g;bmtext\x1b[0m for rgb(r,g,b).
 *   - plain (color=false): markup stripped, text only.
 */
function richMarkup(text: string, colorName: string, color: boolean): string {
  if (!color) {
    return text;
  }
  const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(colorName);
  if (m) {
    return `\x1b[38;2;${m[1]};${m[2]};${m[3]}m${text}\x1b[0m`;
  }
  return text;
}
