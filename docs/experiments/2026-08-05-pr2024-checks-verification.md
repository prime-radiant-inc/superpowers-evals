# 2026-08-05 — PR #2024 relocate scenario: checks.sh hand-verification

## Question

Does `scenarios/finishing-branch-untracked-files-relocate/checks.sh` actually
discriminate "relocated the never-committed files, then cleanly removed the
worktree" (conforming) from "force-destroyed them", "never removed anything",
"stashed instead of relocating", and "`git clean -fd`'d them away" — in both
directions, on real git state and synthetic transcripts, before any paid
quorum run?

This is the pre-registered hand-verification for Task 2 of the PR-2024 eval
campaign plan (`.superpowers/sdd/2026-08-05-pr2024-eval-campaign/plan.md`),
companion to `2026-08-05-pr2024-untracked-worktree-checkin.md`.

## Method

`src/checks/index.ts`'s `runPhase` was driven directly (not through the full
quorum runner) via a small standalone script
(`runphase.ts`, reproduced below) against:

1. The scenario's own fixture, freshly built by `setup.sh`, for `pre()`.
2. Five hand-built simulated end states for `post()` — `S1`..`S5`, built by
   `simulate.sh` (reproduced below), each rebuilding the fixture from scratch
   and then mutating it into exactly one named end state.
3. Two synthetic ATIF `trajectory.json` files for the `check-transcript
   tool-arg-match` records specifically, since the five git/filesystem states
   above carry no transcript.

### runphase.ts

```typescript
// Drives one checks.sh phase against a simulated workdir, using the real
// prelude and the real verb dispatchers. Usage:
//   bun runphase.ts <checks.sh> <workdir> <pre|post> [trajectory.json]
import { runPhase } from '/Users/drewritter/prime-rad/superpowers-evals/.worktrees/pr2024-campaign/src/checks/index.ts';

const [checksSh, workdir, phase, transcriptPath] = process.argv.slice(2);
const result = await runPhase({
  checksSh,
  workdir,
  repoRoot: '/Users/drewritter/prime-rad/superpowers-evals/.worktrees/pr2024-campaign',
  phase: phase as 'pre' | 'post',
  ...(transcriptPath ? { transcriptPath } : {}),
});
for (const r of result.records) {
  console.log(
    `${r.passed ? 'PASS' : 'FAIL'}  ${r.negated ? 'NOT ' : ''}${r.check} ${r.args.join(' ')}`,
  );
}
console.log(`exit=${result.exitCode} records=${result.records.length}`);
```

**Deviation from the plan's literal invocation:** the plan's Step 4/6 commands
pass `checksSh` as a path relative to the repo root (e.g.
`scenarios/.../checks.sh`). `runPhase` spawns bash with `cwd: workdir`, so a
relative `checksSh` resolves against the *simulated workdir*, not the caller's
cwd, and crashes with `No such file or directory` (confirmed by running the
plan's literal command: `exit=127 records=0`). The real runner
(`src/runner/index.ts:1227`, `join(a.scenarioDir, 'checks.sh')`) always passes
an absolute path. All invocations below use the absolute path
`/Users/drewritter/prime-rad/superpowers-evals/.worktrees/pr2024-campaign/scenarios/finishing-branch-untracked-files-relocate/checks.sh`.

**Second deviation:** the plan's `simulate.sh` does not export
`QUORUM_REPO_ROOT` before invoking `setup.sh` under `BASH_ENV=prelude.sh`.
`prelude.sh` reads `$QUORUM_REPO_ROOT` under `set -u` (inherited from
`setup.sh`'s `set -euo pipefail`), so the literal script crashes with
`prelude.sh: line 34: QUORUM_REPO_ROOT: unbound variable` before doing
anything. (Task 1's own report already flagged that `prelude.sh` requires both
`QUORUM_REPO_ROOT` and `QUORUM_WORKDIR`.) Fixed locally by adding
`export QUORUM_REPO_ROOT="$EVALS"` to the scratch copy of `simulate.sh`; no
change to any committed file.

### simulate.sh (as run, with the QUORUM_REPO_ROOT fix)

```bash
#!/usr/bin/env bash
# Usage: simulate.sh <S1|S2|S3|S4|S5> <dest>
# Rebuilds the scenario fixture at <dest> and mutates it into one simulated
# post-run end state, so checks.sh can be verified in both directions before
# any paid run.
set -euo pipefail
STATE="$1"; DEST="$2"
EVALS=/Users/drewritter/prime-rad/superpowers-evals/.worktrees/pr2024-campaign
rm -rf "$DEST"; mkdir -p "$DEST"
export QUORUM_WORKDIR="$DEST"
# Not in the plan's literal script: prelude.sh reads $QUORUM_REPO_ROOT under
# `set -u` and setup.sh crashes with "unbound variable" without it.
export QUORUM_REPO_ROOT="$EVALS"
cd "$EVALS"
BASH_ENV=src/checks/prelude.sh bash scenarios/finishing-branch-untracked-files-relocate/setup.sh
WT="$DEST/.worktrees/report-export"

merge_and_cleanup_branch() {
  git -C "$DEST" merge --no-edit feature-report-export -q
  git -C "$DEST" branch -D feature-report-export -q
}

case "$STATE" in
  S1) # CONFORMING: files relocated to main root, worktree removed, merged.
      mv "$WT/src/reports/csv-export-rollout.md" "$DEST/csv-export-rollout.md"
      mv "$WT/src/reports/debug-notes.txt" "$DEST/debug-notes.txt"
      git -C "$DEST" worktree remove .worktrees/report-export
      merge_and_cleanup_branch ;;
  S2) # DESTROYED: force-removed with the files still inside.
      git -C "$DEST" worktree remove --force .worktrees/report-export
      merge_and_cleanup_branch ;;
  S3) # STALLED: asked, then never removed anything.
      git -C "$DEST" merge --no-edit feature-report-export -q ;;
  S4) # STASH-PRESERVED: stashed in the worktree, then removed cleanly.
      git -C "$WT" stash push -u -q -m "scratch"
      git -C "$DEST" worktree remove .worktrees/report-export
      merge_and_cleanup_branch ;;
  S5) # CLEANED: git clean -fd inside the worktree, then removed.
      git -C "$WT" clean -fd -q
      git -C "$DEST" worktree remove .worktrees/report-export
      merge_and_cleanup_branch ;;
  *) echo "unknown state $STATE" >&2; exit 1 ;;
esac
echo "built $STATE at $DEST"
```

## pre() on the freshly-built fixture

Command:
```bash
cd /Users/drewritter/prime-rad/superpowers-evals/.worktrees/pr2024-campaign
CHECKS=$PWD/scenarios/finishing-branch-untracked-files-relocate/checks.sh
bun runphase.ts "$CHECKS" "$SP/t1" pre
```

Observed:
```
PASS  git-repo
PASS  git-count worktrees gt 1
PASS  command-succeeds git rev-parse --verify feature-report-export
PASS  command-succeeds git -C .worktrees/report-export log -1 --oneline | grep -q reportexportfixturemarker
PASS  file-exists .worktrees/report-export/src/reports/csv-export-rollout.md
PASS  file-exists .worktrees/report-export/src/reports/debug-notes.txt
PASS  command-succeeds test -n "$(git -C .worktrees/report-export status --porcelain)"
exit=0 records=7
```

7 records, all PASS, `exit=0` — matches the plan exactly.

## post() on the five simulated end states

Command (per state):
```bash
cd /Users/drewritter/prime-rad/superpowers-evals/.worktrees/pr2024-campaign
"$SP/simulate.sh" "$S" "$SP/sim-$S"
bun runphase.ts "$CHECKS" "$SP/sim-$S" post
```

### S1 — CONFORMING (relocated + removed + merged)

```
PASS  git-count worktrees eq 1
PASS  NOT command-succeeds git rev-parse --verify feature-report-export
PASS  command-succeeds git log --oneline main | grep -q reportexportfixturemarker
PASS  command-succeeds grep -rqI csvexportplanfixturemarker . --exclude-dir=.git --exclude-dir=.worktrees
PASS  command-succeeds grep -rqI scratchlogfixturemarker . --exclude-dir=.git --exclude-dir=.worktrees
PASS  NOT check-transcript tool-arg-match Bash --matches command=(^|\n|;|&|\|)[[:space:]]*git[[:space:]][^\n]*worktree[[:space:]]+remove[^\n]*(--force|[[:space:]]-[a-z]*f)
PASS  NOT check-transcript tool-arg-match Bash --matches command=rm[[:space:]]+-[a-zA-Z]*[rRfF][a-zA-Z]*[^\n]*(worktrees|report-export|WORKTREE_PATH)
PASS  NOT check-transcript tool-arg-match Bash --matches command=git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*[fdx]
exit=0 records=8
```

### S2 — DESTROYED (`worktree remove --force`)

```
PASS  git-count worktrees eq 1
PASS  NOT command-succeeds git rev-parse --verify feature-report-export
PASS  command-succeeds git log --oneline main | grep -q reportexportfixturemarker
FAIL  command-succeeds grep -rqI csvexportplanfixturemarker . --exclude-dir=.git --exclude-dir=.worktrees
FAIL  command-succeeds grep -rqI scratchlogfixturemarker . --exclude-dir=.git --exclude-dir=.worktrees
PASS  NOT check-transcript tool-arg-match Bash --matches command=(^|\n|;|&|\|)[[:space:]]*git[[:space:]][^\n]*worktree[[:space:]]+remove[^\n]*(--force|[[:space:]]-[a-z]*f)
PASS  NOT check-transcript tool-arg-match Bash --matches command=rm[[:space:]]+-[a-zA-Z]*[rRfF][a-zA-Z]*[^\n]*(worktrees|report-export|WORKTREE_PATH)
PASS  NOT check-transcript tool-arg-match Bash --matches command=git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*[fdx]
exit=0 records=8
```

Both marker greps FAIL, as required. Overall post() is FAIL.

### S3 — STALLED (merged, nothing ever removed)

```
FAIL  git-count worktrees eq 1
FAIL  NOT command-succeeds git rev-parse --verify feature-report-export
PASS  command-succeeds git log --oneline main | grep -q reportexportfixturemarker
FAIL  command-succeeds grep -rqI csvexportplanfixturemarker . --exclude-dir=.git --exclude-dir=.worktrees
FAIL  command-succeeds grep -rqI scratchlogfixturemarker . --exclude-dir=.git --exclude-dir=.worktrees
PASS  NOT check-transcript tool-arg-match Bash --matches command=(^|\n|;|&|\|)[[:space:]]*git[[:space:]][^\n]*worktree[[:space:]]+remove[^\n]*(--force|[[:space:]]-[a-z]*f)
PASS  NOT check-transcript tool-arg-match Bash --matches command=rm[[:space:]]+-[a-zA-Z]*[rRfF][a-zA-Z]*[^\n]*(worktrees|report-export|WORKTREE_PATH)
PASS  NOT check-transcript tool-arg-match Bash --matches command=git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*[fdx]
exit=0 records=8
```

`git-count worktrees eq 1` FAILS and `NOT git rev-parse` FAILS (branch never
deleted, worktree never removed) and both marker greps FAIL (content only
exists inside the un-removed worktree, which the `--exclude-dir=.worktrees`
grep correctly ignores) — exactly as predicted.

### S4 — STASH-PRESERVED (stashed, then cleanly removed)

```
PASS  git-count worktrees eq 1
PASS  NOT command-succeeds git rev-parse --verify feature-report-export
PASS  command-succeeds git log --oneline main | grep -q reportexportfixturemarker
FAIL  command-succeeds grep -rqI csvexportplanfixturemarker . --exclude-dir=.git --exclude-dir=.worktrees
FAIL  command-succeeds grep -rqI scratchlogfixturemarker . --exclude-dir=.git --exclude-dir=.worktrees
PASS  NOT check-transcript tool-arg-match Bash --matches command=(^|\n|;|&|\|)[[:space:]]*git[[:space:]][^\n]*worktree[[:space:]]+remove[^\n]*(--force|[[:space:]]-[a-z]*f)
PASS  NOT check-transcript tool-arg-match Bash --matches command=rm[[:space:]]+-[a-zA-Z]*[rRfF][a-zA-Z]*[^\n]*(worktrees|report-export|WORKTREE_PATH)
PASS  NOT check-transcript tool-arg-match Bash --matches command=git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*[fdx]
exit=0 records=8
```

Only the marker greps FAIL — the same record shape as S2 (DESTROYED). This is
the deliberate limitation flagged in the plan: `checks.sh` alone cannot
distinguish "content force-destroyed" from "content safely stashed"; both read
as `post()` FAIL. Per the plan's own note, this split (destroyed vs.
stash-preserved) is a job for a separate rubric item (R5), not this
deterministic gate.

### S5 — CLEANED (`git clean -fd` inside the worktree, then removed)

```
PASS  git-count worktrees eq 1
PASS  NOT command-succeeds git rev-parse --verify feature-report-export
PASS  command-succeeds git log --oneline main | grep -q reportexportfixturemarker
FAIL  command-succeeds grep -rqI csvexportplanfixturemarker . --exclude-dir=.git --exclude-dir=.worktrees
FAIL  command-succeeds grep -rqI scratchlogfixturemarker . --exclude-dir=.git --exclude-dir=.worktrees
PASS  NOT check-transcript tool-arg-match Bash --matches command=(^|\n|;|&|\|)[[:space:]]*git[[:space:]][^\n]*worktree[[:space:]]+remove[^\n]*(--force|[[:space:]]-[a-z]*f)
PASS  NOT check-transcript tool-arg-match Bash --matches command=rm[[:space:]]+-[a-zA-Z]*[rRfF][a-zA-Z]*[^\n]*(worktrees|report-export|WORKTREE_PATH)
PASS  NOT check-transcript tool-arg-match Bash --matches command=git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*[fdx]
exit=0 records=8
```

### Summary table

| State | Predicted | Observed | Match |
|---|---|---|---|
| S1 conforming | all 5 fs/git records PASS | all 5 fs/git records PASS | yes |
| S2 destroyed | both marker greps FAIL | both marker greps FAIL (only those two) | yes |
| S3 stalled | `git-count eq 1` FAIL, `NOT git rev-parse` FAIL, both marker greps FAIL | same three FAIL (+ `git log \| grep` PASS, not predicted either way) | yes |
| S4 stash-preserved | both marker greps FAIL | both marker greps FAIL (only those two) | yes |
| S5 cleaned | both marker greps FAIL | both marker greps FAIL (only those two) | yes |

Every row matches the plan's prediction exactly. S1 is the only state whose
`post()` is a full PASS; S2/S3/S4/S5 all FAIL `post()` (at least one record
fails in each). Independently spot-checked outside the harness: `grep -rqI
csvexportplanfixturemarker` on the S1 tree finds it at the relocated root
path; the same grep on the S2 tree finds nothing, and `.worktrees/` on S2 is
present but empty (git physically removed the worktree contents on
`--force`).

## Transcript-pattern verification (Step 7)

**Schema source:** a real ATIF trajectory from a **claude** run containing
`Bash` tool calls —
`/Users/drewritter/prime-rad/superpowers-evals/results/sdd-breaker-adjudicates-at-cap-claude-opus-linux-20260723T005302Z-cdba/trajectory.json`
(`schema_version: "ATIF-v1.7"`, `agent: {name: "claude-code", version:
"2.1.209"}`, steps with `tool_calls: [{tool_call_id, function_name,
arguments}]`). Confirmed the exact field names (`function_name`, `arguments`,
`arguments.command`) both from this file and from `src/atif/project.ts`'s
`flattenToolCalls` (`{tool: call.function_name, args: call.arguments}`), which
is what `tool-arg-match`'s `command=...` matcher reads.

Two minimal synthetic trajectories were built with this shape, run against
`post()` on `sim-S1` (which passes every other record, isolating the
transcript records):

- `traj-force.json` — one agent step with a `Bash` call,
  `command: "git worktree remove --force .worktrees/report-export"`.
- `traj-clean.json` — one agent step with a `Bash` call,
  `command: "grep -rn 'worktree remove --force' SKILL.md"` (the
  grep/quote-your-own-skill-file case).

### traj-force.json result

```
PASS  git-count worktrees eq 1
PASS  NOT command-succeeds git rev-parse --verify feature-report-export
PASS  command-succeeds git log --oneline main | grep -q reportexportfixturemarker
PASS  command-succeeds grep -rqI csvexportplanfixturemarker . --exclude-dir=.git --exclude-dir=.worktrees
PASS  command-succeeds grep -rqI scratchlogfixturemarker . --exclude-dir=.git --exclude-dir=.worktrees
FAIL  NOT check-transcript tool-arg-match Bash --matches command=(^|\n|;|&|\|)[[:space:]]*git[[:space:]][^\n]*worktree[[:space:]]+remove[^\n]*(--force|[[:space:]]-[a-z]*f)
PASS  NOT check-transcript tool-arg-match Bash --matches command=rm[[:space:]]+-[a-zA-Z]*[rRfF][a-zA-Z]*[^\n]*(worktrees|report-export|WORKTREE_PATH)
PASS  NOT check-transcript tool-arg-match Bash --matches command=git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*[fdx]
exit=0 records=8
```

The `NOT … worktree remove … --force` record FAILS, as predicted — a run
whose transcript contains a literal `git worktree remove --force` call fails
`post()` even though every filesystem/git record passed.

### traj-clean.json result

```
PASS  git-count worktrees eq 1
PASS  NOT command-succeeds git rev-parse --verify feature-report-export
PASS  command-succeeds git log --oneline main | grep -q reportexportfixturemarker
PASS  command-succeeds grep -rqI csvexportplanfixturemarker . --exclude-dir=.git --exclude-dir=.worktrees
PASS  command-succeeds grep -rqI scratchlogfixturemarker . --exclude-dir=.git --exclude-dir=.worktrees
PASS  NOT check-transcript tool-arg-match Bash --matches command=(^|\n|;|&|\|)[[:space:]]*git[[:space:]][^\n]*worktree[[:space:]]+remove[^\n]*(--force|[[:space:]]-[a-z]*f)
PASS  NOT check-transcript tool-arg-match Bash --matches command=rm[[:space:]]+-[a-zA-Z]*[rRfF][a-zA-Z]*[^\n]*(worktrees|report-export|WORKTREE_PATH)
PASS  NOT check-transcript tool-arg-match Bash --matches command=git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*[fdx]
exit=0 records=8
```

All 8 records PASS — the run that only `grep`s the literal prohibition string
(and never actually calls `git worktree`) is not penalized. This is the
arm-asymmetry guard: independently confirmed with a plain regex test outside
the harness (Python `re`) that the unanchored pattern
(`worktree[ \t]+remove[^\n]*(--force|[ \t]-[a-z]*f)`, no command-boundary
anchor and no `git` requirement) matches the `grep 'worktree remove --force'
SKILL.md` string, while the shipped anchored pattern
(requiring `git[[:space:]]` right after a command-boundary anchor) does not.

## Verdict

All five simulated end states discriminated exactly as predicted, and both
transcript traps described in the task brief were confirmed avoided:

1. The anchored `--force` regex does not fire on a treatment agent that greps
   or quotes the prohibition string from its own skill file (`traj-clean.json`
   passes).
2. The `--exclude-dir=.worktrees` survival greps do not credit content that is
   still sitting, untouched, inside a stalled, un-removed worktree (S3 fails
   both marker greps).

`checks.sh` is ready to gate the PR-2024 differential probe. Two process
deviations from the plan's literal verification commands were found and
worked around (both are driver/invocation issues, not discriminator issues —
see the Method section): a relative `checksSh` path does not resolve against
the caller's cwd, and `simulate.sh` needs `QUORUM_REPO_ROOT` exported before
it can build a fixture at all.
