// The report fold's pinned evidence reader (kernel D4a, task 2): one
// per-sample record distilled from the run dir's frozen artifacts. Every
// field is fail-closed INDEPENDENTLY — a malformed artifact empties its own
// field, never the whole record: the fold still counts the sample by its
// journal class, and an instrument failure must not hide behind a report
// read. Absent run dir ⇒ all-null evidence, never a throw.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AtifTrajectory } from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';
import { ATIF_TRAJECTORY_FILENAME } from '../capture/index.ts';
import { TokenUsageSchema } from '../contracts/economics.ts';
import { GauntletResultSchema } from '../contracts/gauntlet.ts';
import { readVerdictSummary, runCostFromArtifacts } from './dispatcher.ts';
import { gauntletResultDirs } from './sensors.ts';

export interface SampleEvidence {
  /** null outcome = the sample's class comes from the journal (instrument
   *  failure, indeterminate) — the reader returns what the run dir holds. */
  readonly outcome: 'pass' | 'fail' | 'indeterminate' | null;
  readonly observedModels: readonly string[]; // trajectory step model_name set, ordered
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly graderModel: string | null; // gauntlet result.json config.model
}

export function readSampleEvidence(args: {
  readonly runDir: string;
  readonly sampleId: string;
}): SampleEvidence {
  // `<runDir>/verdict.json` via the dispatcher's production reader — the
  // verdict is NOT re-parsed here (single reader, single discipline).
  const verdict = readVerdictSummary(args.runDir);
  return {
    outcome: verdict === null ? null : verdict.outcome,
    observedModels: readObservedModels(args.runDir),
    totalTokens: readTotalTokens(args.runDir),
    costUsd: runCostFromArtifacts(args.runDir),
    graderModel: readGraderModel(args.runDir),
  };
}

/** `<runDir>/trajectory.json` (ATIF_TRAJECTORY_FILENAME) gated by
 *  validateTrajectory — the ATIF contract, so a structurally invalid
 *  trajectory fails closed to [] rather than half-reading. model_name is an
 *  agent-step-only field; collected where present, deduped, sorted
 *  ascending. */
function readObservedModels(runDir: string): readonly string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(
      readFileSync(join(runDir, ATIF_TRAJECTORY_FILENAME), 'utf8'),
    );
  } catch {
    return [];
  }
  if (typeof raw !== 'object' || raw === null) {
    return [];
  }
  try {
    const trajectory = raw as AtifTrajectory;
    if (!validateTrajectory(trajectory).ok) {
      return [];
    }
    const models = new Set<string>();
    for (const step of trajectory.steps) {
      if (typeof step.model_name === 'string' && step.model_name !== '') {
        models.add(step.model_name);
      }
    }
    return [...models].sort();
  } catch {
    // A step entry the validator's own traversal cannot survive (e.g. a null
    // inside steps) — malformed for report purposes.
    return [];
  }
}

/** `<runDir>/coding-agent-token-usage.json` (the frozen capture sidecar,
 *  written by captureTokenUsage, src/capture/index.ts) via the economics
 *  TokenUsageSchema. */
function readTotalTokens(runDir: string): number | null {
  try {
    const parsed = TokenUsageSchema.safeParse(
      JSON.parse(
        readFileSync(join(runDir, 'coding-agent-token-usage.json'), 'utf8'),
      ),
    );
    return parsed.success ? parsed.data.total_tokens : null;
  } catch {
    return null;
  }
}

/** The gauntlet grader's result.json lives at
 *  `<runDir>/gauntlet-agent/results/<runId>/result.json` — the same
 *  production path sensors' gauntlet reads walk (gauntletResultDirs, newest
 *  run-id first; single-run-per-dir convention). The FIRST schema-valid
 *  result determines the field — its config.model, or null when it names
 *  none: an older directory's model is not evidence about the current
 *  result. Unreadable, malformed-JSON, and schema-invalid candidates are
 *  skipped; a schema-valid one terminates the walk. */
function readGraderModel(runDir: string): string | null {
  const { root, dirs } = gauntletResultDirs(runDir);
  for (const id of dirs) {
    let resultJson: string;
    try {
      resultJson = readFileSync(join(root, id, 'result.json'), 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(resultJson);
    } catch {
      continue;
    }
    const result = GauntletResultSchema.safeParse(parsed);
    if (!result.success) {
      continue;
    }
    return result.data.config?.model ?? null;
  }
  return null;
}
