import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CheckPhase,
  type CheckRecord,
  CheckRecordSchema,
} from '../contracts/verdict.ts';
import { envSnapshot, getEnv } from '../env.ts';

// A bin/ tool emits one of these per line into QUORUM_RECORD_SINK (see bin/_record):
// {check, args, negated, passed, detail}. The phase is injected by quorum, not the
// tool, so the sink-line schema is the full CheckRecord minus its phase field.
const SinkRecordSchema = CheckRecordSchema.omit({ phase: true });

export interface RunPhaseArgs {
  readonly checksSh: string;
  readonly phase: CheckPhase;
  readonly workdir: string;
  /** Directory prepended to PATH so the bin/ check tools resolve (the repo bin/). */
  readonly quorumBin: string;
  /** Optional: path to coding-agent-tool-calls.jsonl, exposed to post-checks. */
  readonly toolCallsPath?: string;
  /** Optional: the run dir, exposed to post-checks that read sibling artifacts. */
  readonly runDir?: string;
}

export interface RunPhaseResult {
  readonly records: readonly CheckRecord[];
  /**
   * Crash-aware exit code (parity with quorum/checks.py): a tool that fails its
   * assertion (rc 1) is an ok phase if it emitted a record, but a bash crash
   * (command-not-found / signal / no records) propagates as nonzero.
   */
  readonly exitCode: number;
}

/**
 * Source a scenario's checks.sh and invoke one phase (`pre`/`post`), collecting
 * the CheckRecords its bin/ tools emit. Pure given the filesystem; throws only on
 * an unrecoverable spawn failure (§6.1/§6.4).
 */
export async function runPhase(args: RunPhaseArgs): Promise<RunPhaseResult> {
  const sinkDir = mkdtempSync(join(tmpdir(), 'sink-'));
  const sink = join(sinkDir, 'records.jsonl');

  // Build the subprocess env from the sanctioned snapshot (§6.5), never process.env
  // directly. undefined values are simply absent in the child's environment.
  // Assembled as one literal (conditional spreads for the optional keys) so the
  // names are object properties, not index-signature reads/writes.
  const path = getEnv('PATH') ?? '';
  const env: Record<string, string | undefined> = {
    ...envSnapshot(),
    PATH: `${args.quorumBin}:${path}`,
    QUORUM_RECORD_SINK: sink,
    ...(args.toolCallsPath !== undefined
      ? { QUORUM_TOOL_CALLS_PATH: args.toolCallsPath }
      : {}),
    ...(args.runDir !== undefined ? { QUORUM_RUN_DIR: args.runDir } : {}),
  };

  try {
    const proc = spawnSync(
      'bash',
      ['-c', `source '${args.checksSh}'; ${args.phase}`],
      { cwd: args.workdir, env, encoding: 'utf8' },
    );
    const rc = proc.status ?? 0;
    const records = readRecords(sink, args.phase);

    // Crash heuristic (parity with quorum/checks.py):
    //   rc 0                  -> ok
    //   rc 126/127 or >= 128  -> crash (not-executable / not-found / killed by signal)
    //   rc 1..125             -> ok iff at least one record was emitted, else crash
    let exitCode: number;
    if (rc === 0) {
      exitCode = 0;
    } else if (rc === 126 || rc === 127 || rc >= 128) {
      exitCode = rc;
    } else {
      exitCode = records.length > 0 ? 0 : rc;
    }
    return { records, exitCode };
  } finally {
    rmSync(sinkDir, { recursive: true, force: true });
  }
}

/** Parse every sink line as a CheckRecord, injecting the phase. */
function readRecords(sink: string, phase: CheckPhase): CheckRecord[] {
  let raw: string;
  try {
    raw = readFileSync(sink, 'utf8');
  } catch {
    // No sink file means the phase emitted nothing (e.g. `pre() { :; }`).
    return [];
  }
  const records: CheckRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const parsed = SinkRecordSchema.parse(JSON.parse(line) as unknown);
    records.push({ ...parsed, phase });
  }
  return records;
}

const DIRECTIVE_RE = /^#\s*coding-agents:\s*(.+)$/;

/**
 * Read a leading `# coding-agents: a, b` directive from a checks.sh, returning the
 * trimmed CSV members. Internal absence is undefined (§5.5), not null.
 */
export function parseCodingAgentsDirective(
  checksSh: string,
): string[] | undefined {
  const head = readFileSync(checksSh, 'utf8').split('\n').slice(0, 20);
  for (const line of head) {
    const match = DIRECTIVE_RE.exec(line);
    const csv = match?.[1];
    if (csv !== undefined) {
      const members = csv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (members.length > 0) {
        return members;
      }
    }
  }
  return undefined;
}
