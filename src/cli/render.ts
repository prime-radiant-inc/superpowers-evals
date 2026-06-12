import { z } from 'zod';
import type { FinalStatus, FinalVerdict } from '../contracts/verdict.ts';
import { assertNever } from '../invariant.ts';

export type ShowMode = 'full' | 'quiet' | 'json';

export interface RenderOptions {
  readonly color: boolean;
  readonly mode: ShowMode;
}

type Rgb = readonly [number, number, number];

// Dracula-palette 24-bit colors for the three verdicts. A closed switch over
// the FinalStatus union (coding standard 5.1) keeps this exhaustive without an
// index-signature lookup that noUncheckedIndexedAccess would widen to an
// optional Rgb.
function finalRgb(final: FinalStatus): Rgb {
  switch (final) {
    case 'pass':
      return [80, 250, 123];
    case 'fail':
      return [255, 85, 85];
    case 'indeterminate':
      return [241, 250, 140];
    default:
      return assertNever(final);
  }
}

function paint(text: string, rgb: Rgb, on: boolean): string {
  if (!on) {
    return text;
  }
  const [r, g, b] = rgb;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

// The economics block is opaque at the verdict layer (a record of unknowns).
// Re-parse just the one field the renderer reads, rather than asserting a shape
// (coding standard 4.1: parse, don't cast).
const EconomicsViewSchema = z.object({
  total_est_cost_usd: z.number().nullable().optional(),
});

function basename(path: string): string {
  const last = path.split('/').at(-1);
  return last !== undefined && last !== '' ? last : path;
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
    return `${verdict.final}\n${verdict.final_reason}\n`;
  }

  const lines: string[] = [];
  lines.push(basename(runDir));
  lines.push(
    `${paint(verdict.final.toUpperCase(), finalRgb(verdict.final), opts.color)}  ${verdict.final_reason}`,
  );

  if (verdict.gauntlet) {
    lines.push(`gauntlet: ${verdict.gauntlet.status}`);
    if (verdict.gauntlet.summary) {
      lines.push(`  ${verdict.gauntlet.summary}`);
    }
  }

  for (const phase of ['pre', 'post'] as const) {
    for (const check of verdict.checks) {
      if (check.phase !== phase) {
        continue;
      }
      const glyph = check.passed ? '✓' : '✗';
      const not = check.negated ? 'NOT ' : '';
      const args = check.args.length > 0 ? ` ${check.args.join(' ')}` : '';
      const detail = check.detail ? ` ↳ ${check.detail}` : '';
      lines.push(`  [${phase}] ${glyph} ${not}${check.check}${args}${detail}`);
    }
  }

  if (verdict.economics) {
    const view = EconomicsViewSchema.safeParse(verdict.economics);
    const total = view.success ? view.data.total_est_cost_usd : undefined;
    lines.push(
      `economics: ${total === null || total === undefined ? '(partial)' : `$${total}`}`,
    );
  }

  return `${lines.join('\n')}\n`;
}
