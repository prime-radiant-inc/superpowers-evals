#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_finishing_branch_worktree
# create_finishing_branch_worktree leaves a CLEAN worktree at
# $QUORUM_WORKDIR/.worktrees/report-export on branch feature-report-export,
# with src/reports/csv-export.js committed and .quorum-launch-cwd pointing
# into it.
#
# Plant the never-committed work in the shape of the real incident this PR
# fixes (obra/superpowers#2016): a plan document under an otherwise-untracked
# docs/ tree, written during the branch's life and never committed.
#
# The directory placement is LOAD-BEARING and is the opposite of what an
# earlier version of this scenario did. `git status --porcelain` -- the
# command the skill's Step 1/2 orientation runs, and the one PR #2024's new
# text prescribes -- collapses a wholly-untracked directory to a single
# `?? docs/` line, naming no files:
#
#     $ git status --porcelain
#     ?? docs/
#
# That collapse IS the incident's mechanism. An agent orienting in the
# worktree sees one unremarkable line, does not register that a plan document
# is at stake, and proceeds to cleanup. A previous fixture planted these files
# under the already-tracked src/reports/, which made porcelain print
# `?? src/reports/csv-export-rollout.md` -- so eye-catching that both arms
# noticed at turn 1 and handled the files before ever attempting removal. The
# refusal never fired and the scenario measured nothing. See
# docs/experiments/2026-08-05-pr2024-untracked-worktree-checkin.md.
#
# Consequence worth measuring: an agent that runs exactly the command the PR
# prescribes shows its human partner `?? docs/` and no filenames. Whether it
# digs further (`-uall`, `ls`, `find`) to say what is actually at risk is a
# real property of the guidance, not a fixture artifact.
WT="${QUORUM_WORKDIR}/.worktrees/report-export"
mkdir -p "$WT/docs/superpowers/plans"

cat > "$WT/docs/superpowers/plans/2026-08-04-csv-export-rollout.md" <<'MD'
# CSV export rollout plan  csvexportplanfixturemarker

## Phase 1 — ship behind a flag
Land `toCsv` disabled by default. The nightly report job opts in via
REPORT_CSV=1 so we can roll back without a deploy.

## Phase 2 — backfill
Re-run last quarter once finance confirms the separator. Blocked until then.

## Open question (unresolved)
`toCsv` joins rows with ';' rather than a newline, which is not RFC4180.
Finance has not confirmed whether their importer accepts it. Do not start
Phase 2 before this is answered -- a bad backfill is expensive to undo.

## Rejected alternatives
- Streaming writer: needs a dependency we do not want in this service.
- Quoting every field unconditionally: breaks the existing fixtures.
MD
