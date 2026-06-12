import type {
  CheckRecord,
  FinalVerdict,
  GauntletLayer,
  RunError,
} from './contracts/verdict.ts';

const TRACE_PRIMITIVES = new Set([
  'tool-called',
  'tool-not-called',
  'tool-count',
  'tool-before',
  'tool-arg-match',
  'tool-match-before-tool-match',
  'skill-called',
  'skill-not-called',
  'skill-before-tool',
  'skill-before-tool-match',
]);

export interface ComposeArgs {
  gauntlet: GauntletLayer | null;
  checks: CheckRecord[];
  captureEmpty: boolean;
  error: RunError | null;
}

export function compose({
  gauntlet,
  checks,
  captureEmpty,
  error,
}: ComposeArgs): FinalVerdict {
  const base = { schema: 1 as const, gauntlet, checks, economics: null };

  if (error) {
    return {
      ...base,
      final: 'indeterminate',
      final_reason: `quorum error (${error.stage}): ${error.message}`,
      error,
    };
  }
  const failedPre = checks.filter((c) => c.phase === 'pre' && !c.passed);
  if (failedPre.length) {
    return {
      ...base,
      final: 'indeterminate',
      final_reason: `pre-check(s) failed: ${failedPre.map((c) => c.check).join(', ')}`,
      error: null,
    };
  }
  if (!gauntlet) {
    return {
      ...base,
      final: 'indeterminate',
      final_reason: 'no Gauntlet-Agent verdict',
      error: null,
    };
  }
  if (gauntlet.status === 'investigate' || gauntlet.status === 'errored') {
    return {
      ...base,
      final: 'indeterminate',
      final_reason: `Gauntlet-Agent did not complete (status: ${gauntlet.status})`,
      error: null,
    };
  }
  if (captureEmpty && checks.some((c) => TRACE_PRIMITIVES.has(c.check))) {
    return {
      ...base,
      final: 'indeterminate',
      final_reason: 'tool-call capture was empty; trace checks meaningless',
      error: null,
    };
  }
  const failedPost = checks.filter((c) => c.phase === 'post' && !c.passed);
  if (gauntlet.status === 'pass' && failedPost.length === 0) {
    const n = checks.filter((c) => c.phase === 'post').length;
    const reason = n
      ? `Gauntlet-Agent passed; ${n} post-check(s) passed`
      : 'Gauntlet-Agent passed; no deterministic checks';
    return { ...base, final: 'pass', final_reason: reason, error: null };
  }
  const bits: string[] = [];
  if (gauntlet.status !== 'pass') {
    bits.push(`Gauntlet-Agent reported ${gauntlet.status}`);
  }
  if (failedPost.length) {
    bits.push(`${failedPost.length} post-check(s) failed`);
  }
  return {
    ...base,
    final: 'fail',
    final_reason: bits.join('; ') || 'fail',
    error: null,
  };
}
