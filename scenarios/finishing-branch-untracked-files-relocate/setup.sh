#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_finishing_branch_worktree
# create_finishing_branch_worktree leaves a CLEAN worktree at
# $QUORUM_WORKDIR/.worktrees/report-export on branch feature-report-export,
# with src/reports/csv-export.js committed and .quorum-launch-cwd pointing
# into it. Plant never-committed work there: `git worktree remove` refuses on
# any untracked file, and that refusal ("contains modified or untracked
# files") is the exact condition PR #2024's new Step 6 branch keys off.
#
# Both files MUST go under src/reports/, which the fixture already tracks.
# Git collapses a wholly-untracked directory in `git status --porcelain` --
# the command the skill prescribes -- to a bare "?? docs/", listing zero
# filenames. An agent that complied exactly would then appear to have shown
# no file list. A tracked parent directory yields full paths.
WT="${QUORUM_WORKDIR}/.worktrees/report-export"

cat > "$WT/src/reports/csv-export-rollout.md" <<'MD'
# CSV export rollout plan  csvexportplanfixturemarker

Phase 1: ship toCsv behind a flag for the nightly report job.
Phase 2: backfill last quarter once finance signs off on the quoting rules.

Open question: the current separator is ';' and finance has not confirmed
whether their importer accepts it. Needs an answer before Phase 2.
MD

cat > "$WT/src/reports/debug-notes.txt" <<'TXT'
scratchlogfixturemarker

toCsv joins rows with ';' not a newline -- confirm with the reporting team
before the Phase 2 backfill.
TXT
