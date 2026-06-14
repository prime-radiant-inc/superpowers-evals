/**
 * Source a scenario's checks.sh, run a phase, collect the records.
 *
 * A scenario's checks.sh defines two bash functions, `pre()` and `post()`. The
 * quorum invokes one phase at a time:
 *
 *     bash -c 'source <checks.sh>; <phase>'
 *
 * with cwd=<workdir>, PATH prepending bin/, and QUORUM_RECORD_SINK pointing at
 * a fresh JSONL file. Each check tool emits one record; this module parses the
 * records and returns CheckRecord values. The phase is stamped here.
 *
 * The script's *exit code* is the crash signal — non-zero means the script did
 * not run to completion. Pass/fail comes from the records.
 *
 * Port of quorum/checks.py.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Phase = "pre" | "post";

export interface CheckRecord {
  check: string;
  args: unknown[];
  negated: boolean;
  passed: boolean;
  detail?: string | null;
  phase: Phase;
}

// ---------------------------------------------------------------------------
// parseCodingAgentsDirective
// ---------------------------------------------------------------------------

// Mirrors Python's _DIRECTIVE_RE = re.compile(r"^\s*#\s*coding-agents:\s*(.+?)\s*$")
const _DIRECTIVE_RE = /^\s*#\s*coding-agents:\s*(.+?)\s*$/;

/**
 * Return the list from `# coding-agents: <csv>` if present in the file, else null.
 *
 * Scans only the first ~20 lines; the directive must be a top-of-file comment.
 * Port of Python's parse_coding_agents_directive.
 */
export function parseCodingAgentsDirective(checksSh: string): string[] | null {
  if (!fs.existsSync(checksSh)) {
    return null;
  }
  const text = fs.readFileSync(checksSh, "utf-8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 20) break;
    const line = lines[i] ?? "";
    const m = _DIRECTIVE_RE.exec(line);
    if (m) {
      const csv = m[1] ?? "";
      return csv
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// runPhase
// ---------------------------------------------------------------------------

/**
 * Source checks.sh, call <phase>, return { records, exitCode }.
 *
 * The exit code is the crash signal: non-zero means the script did not run to
 * completion (per spec §7). Callers always need both — never just the records.
 *
 * Port of Python's run_phase.
 */
export function runPhase(opts: {
  checksSh: string;
  phase: Phase;
  workdir: string;
  quorumBin: string;
  transcriptPath?: string;
  runDir?: string;
}): { records: CheckRecord[]; exitCode: number } {
  const { checksSh, phase, workdir, quorumBin, transcriptPath, runDir } = opts;

  // Create a fresh temp file as the JSONL sink for check records.
  const sinkPath = path.join(
    os.tmpdir(),
    `quorum-sink-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  fs.writeFileSync(sinkPath, "");

  try {
    // Inherit process.env for PATH and friends — checks like `requires-tool npm`
    // or `command-succeeds 'go test'` need brew / pyenv / nvm tools that don't
    // live in /usr/bin or /bin. Prepend quorumBin so the check vocabulary
    // wins lookups, then layer our own overrides on top.
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: `${quorumBin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      QUORUM_RECORD_SINK: sinkPath,
    };

    if (transcriptPath !== undefined) {
      // ATIF trajectory.json for the new check-transcript CLI. Set even when
      // the file is absent (agent without ATIF support, or emission failed):
      // check-transcript's loader treats a missing file as empty (fail-closed),
      // so check execution must not depend on the file existing.
      env["QUORUM_TRANSCRIPT_PATH"] = transcriptPath;
    }

    if (runDir !== undefined) {
      // Anchor for checks that need sibling paths (e.g. coding-agent-config/).
      // cwd inside checks.sh is the workdir, so siblings need an explicit anchor.
      env["QUORUM_RUN_DIR"] = runDir;
    }

    const proc = Bun.spawnSync(
      ["bash", "-c", `source '${checksSh}'; ${phase}`],
      { cwd: workdir, env },
    );

    const sinkText = fs.readFileSync(sinkPath, "utf-8");
    const records: CheckRecord[] = sinkText
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const d = JSON.parse(line) as Record<string, unknown>;
        return {
          check: d["check"] as string,
          args: d["args"] as unknown[],
          negated: d["negated"] as boolean,
          passed: d["passed"] as boolean,
          detail: (d["detail"] ?? null) as string | null,
          phase,
        };
      });

    const returncode = proc.exitCode ?? 0;

    // The exit code is the crash signal (spec §7). Distinguishing a
    // *crash* from a *check failure* requires looking at where the exit
    // code lands:
    //
    //   - 0 → phase ran clean to the end. No crash.
    //   - 126 (not-executable), 127 (command-not-found), >= 128
    //     (signal-killed) → bash itself crashed mid-phase. Typo'd
    //     function name (`tools-called` instead of `tool-called`) is the
    //     common bite; that's exit 127. Treat as crash regardless of
    //     whether records were emitted before it happened.
    //   - 1-125 → either a check tool's intentional fail-exit, OR a
    //     user-written `false` / bad conditional. Treat as completed
    //     when any records were emitted; treat as crash when none were
    //     (the script likely failed before any tool ran).
    //
    // This is a heuristic — it can miss a crash whose exit happens to
    // land in 1-125 *and* is followed by no further records (so we
    // incorrectly assume "tool failed"). Codex flagged a stricter
    // alternative — change every tool to exit 0 always, drive crash
    // detection purely off returncode — which is cleaner but a much
    // larger contract change. The heuristic catches every typo-style
    // crash (which is what bites in practice) without that surgery.
    const crashCodes =
      returncode === 126 || returncode === 127 || returncode >= 128;

    let exitCode: number;
    if (returncode === 0) {
      exitCode = 0;
    } else if (crashCodes) {
      exitCode = returncode;
    } else if (records.length > 0) {
      exitCode = 0;
    } else {
      exitCode = returncode;
    }

    return { records, exitCode };
  } finally {
    try {
      fs.unlinkSync(sinkPath);
    } catch {
      // ignore cleanup errors
    }
  }
}
