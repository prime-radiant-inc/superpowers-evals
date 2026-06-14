/**
 * Compose the three-valued verdict from the Gauntlet-Agent layer and the
 * deterministic checks layer.
 *
 * Port of quorum/composer.py.
 */

import type { CheckRecord } from "./checks.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FinalStatus = "pass" | "fail" | "indeterminate";
export type GauntletStatus = "pass" | "fail" | "investigate" | "errored";
export type RunErrorStage =
  | "setup"
  | "gauntlet"
  | "capture"
  | "checks"
  | "compose"
  | "qa-agent-misconfigured"
  | "unknown";

// Every transcript verb the check-transcript CLI emits. An empty tool-call
// capture makes all of these meaningless, so the capture-empty guard
// (anyTraceCheck) must recognize every one of them to force indeterminate
// rather than a false pass/fail. Keep this in sync with the `case` verbs in
// ts/src/cli/check-transcript.ts.
export const TRACE_PRIMITIVES: Set<string> = new Set([
  "tool-called",
  "tool-not-called",
  "tool-count",
  "tool-before",
  "tool-arg-match",
  "tool-match-before-tool-match",
  "skill-called",
  "skill-not-called",
  "skill-before-tool",
  "skill-before-implementation-tool",
  "implementation-tool-not-called",
  "investigated",
  "worktree-created",
]);

export interface GauntletLayer {
  status: GauntletStatus;
  summary?: string;
  reasoning?: string;
  runId?: string | null;
}

export interface RunError {
  stage: RunErrorStage;
  message: string;
}

export interface FinalVerdict {
  schema: number;
  final: FinalStatus;
  finalReason: string;
  gauntlet: GauntletLayer | null;
  checks: CheckRecord[];
  error: RunError | null;
  economics: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// toDict — produce the EXACT verdict.json shape that Python's to_dict emits
// ---------------------------------------------------------------------------

/**
 * Serialize a FinalVerdict to the exact dict shape produced by the Python
 * FinalVerdict.to_dict() method: snake_case keys, gauntlet with run_id,
 * checks array with {check, args, negated, passed, detail, phase},
 * error as {stage, message} or null, economics as-is.
 */
export function toDict(v: FinalVerdict): object {
  return {
    schema: v.schema,
    final: v.final,
    final_reason: v.finalReason,
    gauntlet:
      v.gauntlet !== null
        ? {
            status: v.gauntlet.status,
            summary: v.gauntlet.summary ?? "",
            reasoning: v.gauntlet.reasoning ?? "",
            run_id: v.gauntlet.runId ?? null,
          }
        : null,
    checks: v.checks.map((c) => ({
      check: c.check,
      args: c.args,
      negated: c.negated,
      passed: c.passed,
      detail: c.detail ?? null,
      phase: c.phase,
    })),
    error:
      v.error !== null
        ? { stage: v.error.stage, message: v.error.message }
        : null,
    economics: v.economics,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function anyTraceCheck(checks: CheckRecord[]): boolean {
  return checks.some((c) => TRACE_PRIMITIVES.has(c.check));
}

// ---------------------------------------------------------------------------
// compose — pure decision tree
// ---------------------------------------------------------------------------

/**
 * Compose the three-valued verdict from the Gauntlet-Agent layer and the
 * deterministic checks layer. Port of Python's compose().
 *
 * Decision tree (in order):
 *  1. error != null → indeterminate "quorum error (<stage>): <message>"
 *  2. failed pre checks → indeterminate "pre-check(s) failed: <names>"
 *  3. gauntlet == null → indeterminate "no Gauntlet-Agent verdict"
 *  4. gauntlet investigate/errored → indeterminate
 *  5. captureEmpty && anyTraceCheck → indeterminate "tool-call capture was empty..."
 *  6. gauntlet pass && no failed post → pass
 *  7. else → fail
 */
export function compose(opts: {
  gauntlet: GauntletLayer | null;
  checks: CheckRecord[];
  captureEmpty: boolean;
  error: RunError | null;
}): FinalVerdict {
  const { gauntlet, checks, captureEmpty, error } = opts;

  // 1. Crash path
  if (error !== null) {
    return {
      schema: 1,
      final: "indeterminate",
      finalReason: `quorum error (${error.stage}): ${error.message}`,
      gauntlet,
      checks,
      error,
      economics: null,
    };
  }

  // 2. Pre-check failure
  const failedPre = checks.filter((c) => c.phase === "pre" && !c.passed);
  if (failedPre.length > 0) {
    const names = failedPre.map((c) => c.check).join(", ");
    return {
      schema: 1,
      final: "indeterminate",
      finalReason: `pre-check(s) failed: ${names}`,
      gauntlet,
      checks,
      error: null,
      economics: null,
    };
  }

  // 3. No Gauntlet verdict
  if (gauntlet === null) {
    return {
      schema: 1,
      final: "indeterminate",
      finalReason: "no Gauntlet-Agent verdict",
      gauntlet: null,
      checks,
      error: null,
      economics: null,
    };
  }

  // 4. Gauntlet investigate/errored
  if (gauntlet.status === "investigate" || gauntlet.status === "errored") {
    return {
      schema: 1,
      final: "indeterminate",
      finalReason: `Gauntlet-Agent did not complete (status: ${gauntlet.status})`,
      gauntlet,
      checks,
      error: null,
      economics: null,
    };
  }

  // 5. Empty trace with trace checks
  if (captureEmpty && anyTraceCheck(checks)) {
    return {
      schema: 1,
      final: "indeterminate",
      finalReason: "tool-call capture was empty; trace checks meaningless",
      gauntlet,
      checks,
      error: null,
      economics: null,
    };
  }

  // 6. Post-check evaluation
  const failedPost = checks.filter((c) => c.phase === "post" && !c.passed);
  if (gauntlet.status === "pass" && failedPost.length === 0) {
    const n = checks.filter((c) => c.phase === "post").length;
    const reason =
      n > 0
        ? `Gauntlet-Agent passed; ${n} post-check(s) passed`
        : "Gauntlet-Agent passed; no deterministic checks";
    return {
      schema: 1,
      final: "pass",
      finalReason: reason,
      gauntlet,
      checks,
      error: null,
      economics: null,
    };
  }

  // 7. Fail
  const reasonBits: string[] = [];
  if (gauntlet.status !== "pass") {
    reasonBits.push(`Gauntlet-Agent reported ${gauntlet.status}`);
  }
  if (failedPost.length > 0) {
    reasonBits.push(`${failedPost.length} post-check(s) failed`);
  }
  return {
    schema: 1,
    final: "fail",
    finalReason: reasonBits.join("; ") || "fail",
    gauntlet,
    checks,
    error: null,
    economics: null,
  };
}
