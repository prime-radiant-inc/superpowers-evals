// check/dispatch.ts — the single typed check-tool dispatcher.
//
// Every check verb (the filesystem/git/env verbs AND the transcript verbs)
// resolves to one pure function returning a CheckOutcome. The CLI
// (src/cli/check-tool.ts) maps the outcome to a record + exit code; `negate`
// runs an inner verb in-process to implement `not`.
//
// The 127 crash band is preserved: a broken/under-specified check returns
// {broken:true}, which the CLI turns into exit 127 (non-invertible) so it can't
// vacuously pass or be inverted by `not`.

import {
  type CheckContext,
  type CheckOutcome,
  verbAntigravityPluginInstalled,
  verbAssertCheckoutClean,
  verbCodexNativeHookConfigured,
  verbCommandSucceeds,
  verbCopilotPluginInstalled,
  verbFileContains,
  verbFileExists,
  verbFilesExist,
  verbGeminiExtensionLinked,
  verbGitBranch,
  verbGitClean,
  verbGitCount,
  verbGitRepo,
  verbKimiPluginInstalled,
  verbOpencodePluginInstalled,
  verbRequiresTool,
} from './fs-verbs.ts';
import { loadCalls } from './transcript.ts';
import { transcriptOutcome } from './transcript-dispatch.ts';

export type { CheckContext, CheckOutcome };

/** A filesystem/git/env verb: (args, ctx) => CheckOutcome. */
export type VerbFn = (args: string[], ctx: CheckContext) => CheckOutcome;

// The non-transcript check vocabulary. The record's `check` field is the verb
// name.
export const FS_VERBS: Record<string, VerbFn> = {
  'file-exists': verbFileExists,
  'file-contains': verbFileContains,
  'command-succeeds': verbCommandSucceeds,
  'git-repo': verbGitRepo,
  'git-branch': verbGitBranch,
  'git-clean': verbGitClean,
  'git-count': verbGitCount,
  'assert-checkout-clean': verbAssertCheckoutClean,
  'requires-tool': verbRequiresTool,
  'files-exist': verbFilesExist,
  'antigravity-plugin-installed': verbAntigravityPluginInstalled,
  'copilot-plugin-installed': verbCopilotPluginInstalled,
  'opencode-plugin-installed': verbOpencodePluginInstalled,
  'gemini-extension-linked': verbGeminiExtensionLinked,
  'kimi-plugin-installed': verbKimiPluginInstalled,
  'codex-native-hook-configured': verbCodexNativeHookConfigured,
};

/**
 * Run a check verb by name, in-process, returning its CheckOutcome.
 *
 * `check-transcript` is handled specially: its first arg is the transcript verb
 * and the rest its args; the transcript dispatch owns its own arity/usage gates
 * (returning {broken:true} for usage errors / unknown verbs).
 *
 * An unknown verb returns null so the caller can route it through the
 * non-invertible 127 band with an "unknown verb" message (and so `negate` can
 * refuse to invert a missing tool).
 */
export function runVerb(
  verb: string,
  args: string[],
  ctx: CheckContext,
): CheckOutcome | null {
  if (verb === 'check-transcript') {
    const sub = args[0] ?? '';
    const subArgs = args.slice(1);
    const { calls, empty } = loadCalls();
    return transcriptOutcome(sub, subArgs, calls, empty);
  }
  const fn = FS_VERBS[verb];
  if (!fn) {
    return null;
  }
  return fn(args, ctx);
}

/**
 * Implement `not <inner> [args...]` in-process.
 *
 * Three load-bearing rules:
 *   1. On a normal inner pass/fail, emit ONE record on the inner's behalf —
 *      check=<inner>, negated:true, passed=<inverted>, detail=null. Exit 0 iff
 *      the inner FAILED (the negation passed).
 *   2. Refuse to invert a MISSING tool (unknown inner verb). Record a FAIL under
 *      `not`'s own name and exit 1 — an honest failed check, NOT the 127 crash
 *      band (a 127 would crash the whole phase via runPhase's heuristic; `not`
 *      deliberately uses exit 1).
 *   3. Refuse to invert a CRASH (the inner verb returned broken, or threw).
 *      Same handling as rule 2: record FAIL under `not`, exit 1.
 *
 * The CLI maps `refused:true` to exit 1 (not 127); a non-refused result exits 0
 * iff `passed`.
 */
export interface NegateResult {
  /** The record's `check` field. */
  check: string;
  /** The record's `args` field. */
  args: string[];
  /** The record's `negated` field. */
  negated: boolean;
  /** The record's `passed` field. */
  passed: boolean;
  /** The record's detail (`''` → null in the record). */
  detail: string;
  /**
   * The negation refused to invert (missing inner tool / inner crash). Recorded
   * under `not` with passed:false; the CLI exits 1, NOT 127.
   */
  refused: boolean;
}

export function negate(args: string[], ctx: CheckContext): NegateResult {
  const inner = args[0] ?? '';
  const innerArgs = args.slice(1);

  // Rule 2: a missing inner tool must not be invertible. Record under
  // `not`'s own name with a fail, and exit 1.
  const known = inner === 'check-transcript' || inner in FS_VERBS;
  if (!known) {
    return {
      check: 'not',
      args,
      negated: false,
      passed: false,
      detail: `unknown inner tool: ${inner}`,
      refused: true,
    };
  }

  // Run the inner verb in-process with NO record emitted (we synthesize the
  // negated record here). Rule 3: an inner crash (broken / thrown) is not
  // invertible.
  let outcome: CheckOutcome | null;
  try {
    outcome = runVerb(inner, innerArgs, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      check: 'not',
      args,
      negated: false,
      passed: false,
      detail: `inner tool ${inner} crashed: ${message}`,
      refused: true,
    };
  }
  if (outcome === null || outcome.broken) {
    return {
      check: 'not',
      args,
      negated: false,
      passed: false,
      detail: `inner tool ${inner} crashed${outcome?.detail ? `: ${outcome.detail}` : ''}`,
      refused: true,
    };
  }

  // Rule 1 + invert: the negation passes iff the inner FAILED.
  const inverted = !outcome.passed;
  return {
    check: inner,
    args: innerArgs,
    negated: true,
    passed: inverted,
    detail: '',
    refused: false,
  };
}
