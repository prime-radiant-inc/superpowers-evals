import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CheckPhase,
  type CheckRecord,
  CheckRecordSchema,
} from '../contracts/verdict.ts';
import { envSnapshot, getEnv } from '../env.ts';

// A bin/ check tool emits one of these per line into QUORUM_RECORD_SINK. The
// tools are thin shims over the typed dispatcher (src/cli/check-tool.ts), whose
// sole record emitter is src/check/record.ts: {check, args, negated, passed,
// detail}. The phase is injected by quorum, not the tool, so the sink-line
// schema is the full CheckRecord minus its phase field.
const SinkRecordSchema = CheckRecordSchema.omit({ phase: true });

export interface RunPhaseArgs {
  readonly checksSh: string;
  readonly phase: CheckPhase;
  readonly workdir: string;
  /**
   * The quorum repo root. Exposed to the child as QUORUM_REPO_ROOT and used to
   * locate the sourced check prelude (src/checks/prelude.sh), which defines the
   * bare-verb DSL (file-exists, git-count, not, check-transcript, …) as
   * functions delegating to the TS check CLIs.
   */
  readonly repoRoot: string;
  /**
   * Directory prepended to PATH so the legacy bin/ check shims resolve. Retained
   * only during the prelude migration's dual-wire window; removed once the
   * prelude is the sole resolution path.
   */
  readonly quorumBin: string;
  /** Optional: path to the ATIF trajectory.json, exposed to transcript checks. */
  readonly transcriptPath?: string;
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
  // Match quorum/checks.py:82 — an unset PATH falls back to the system default,
  // not '' (a '' fallback yields `{quorumBin}:` whose trailing empty component is
  // CWD on POSIX and drops /usr/bin:/bin, so even bash itself fails to resolve).
  const path = getEnv('PATH') ?? '/usr/bin:/bin';
  const prelude = join(args.repoRoot, 'src', 'checks', 'prelude.sh');
  const env: Record<string, string | undefined> = {
    ...envSnapshot(),
    PATH: `${args.quorumBin}:${path}`,
    QUORUM_REPO_ROOT: args.repoRoot,
    QUORUM_RECORD_SINK: sink,
    ...(args.transcriptPath !== undefined
      ? { QUORUM_TRANSCRIPT_PATH: args.transcriptPath }
      : {}),
    ...(args.runDir !== undefined ? { QUORUM_RUN_DIR: args.runDir } : {}),
  };

  try {
    const proc = spawnSync(
      'bash',
      ['-c', `source '${prelude}'; source '${args.checksSh}'; ${args.phase}`],
      {
        cwd: args.workdir,
        env,
        encoding: 'utf8',
        // Python's subprocess.run has no output cap. spawnSync defaults maxBuffer
        // to 1 MB of stdout+stderr; a verbose pre()/post() body would otherwise
        // return {status:null, error:{code:'ENOBUFS'}}, tripping the spawn-error
        // guard below and discarding records the check tools already wrote to the
        // sink. Uncap to match Python and preserve those records.
        maxBuffer: Number.POSITIVE_INFINITY,
      },
    );
    // Python's subprocess.run raises FileNotFoundError when bash cannot be
    // spawned; that exception propagates out of run_phase. Node's spawnSync does
    // NOT throw on spawn failure — it returns {status:null, error:<Error>}. Mirror
    // the raise rather than swallowing it into a clean, empty phase.
    if (proc.error) {
      throw proc.error;
    }
    const records = readRecords(sink, args.phase);

    // A signal-killed bash child (OOM-killer, timeout SIGKILL) returns
    // status:null with proc.signal set. Such a phase DIED MID-RUN, so its result
    // is untrustworthy and incomplete — it is a CRASH regardless of any partial
    // records. This DELIBERATELY DIVERGES from Python (quorum/checks.py:134-143
    // maps a signal to a negative returncode and would treat a killed-with-records
    // phase as clean): a killed phase is never "clean". Map the kill into the
    // >=128 crash band (128 + signo) so the composer reports a checks crash; the
    // records above are still surfaced for the verdict's check list.
    if (proc.signal) {
      return { records, exitCode: 128 + signalNumber(proc.signal) };
    }
    const rc = proc.status ?? 0;

    // Crash heuristic (parity with quorum/checks.py:134-143):
    //   rc 0                  -> ok
    //   rc 126/127 or >= 128  -> crash (not-executable / not-found)
    //   else (1..125)         -> ok iff at least one record was emitted, else crash
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

/** Map a signal name (e.g. "SIGKILL") to its number; SIGKILL (9) if unknown. */
function signalNumber(signal: NodeJS.Signals): number {
  return constants.signals[signal] ?? constants.signals.SIGKILL;
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

// Mirror of quorum/checks.py:_DIRECTIVE_RE — `^\s*#\s*coding-agents:\s*(.+?)\s*$`.
// Leading whitespace before the `#` is allowed; the trailing `\s*$` plus the
// non-greedy `(.+?)` mean a bare `# coding-agents:` (no value) does NOT match.
const DIRECTIVE_RE = /^\s*#\s*coding-agents:\s*(.+?)\s*$/;

/**
 * Read a leading `# coding-agents: a, b` directive from a checks.sh, returning the
 * trimmed CSV members. A line that matches the directive but lists only
 * separators (e.g. `# coding-agents: ,`) is a *matched-but-empty* directive and
 * returns `[]` (parity with quorum/checks.py:56) — the matrix gate reads `[]` as
 * skip-all-agents, whereas a true absence (no matching line, or a missing
 * checks.sh) returns `undefined` (§5.5).
 */
export function parseCodingAgentsDirective(
  checksSh: string,
): string[] | undefined {
  // Python guards `if not checks_sh.exists(): return None` (quorum/checks.py:49)
  // before reading; a story-only scenario dir has no checks.sh and must be
  // treated as un-gated rather than crashing the matrix build.
  if (!existsSync(checksSh)) {
    return undefined;
  }
  // Python scans line indices 0..20 inclusive (`if i > 20: break`) — 21 lines.
  const head = readFileSync(checksSh, 'utf8').split('\n').slice(0, 21);
  for (const line of head) {
    const match = DIRECTIVE_RE.exec(line);
    const csv = match?.[1];
    if (csv !== undefined) {
      return csv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return undefined;
}
