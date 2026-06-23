# checks/prelude.sh — the bare-verb DSL for scenario setup.sh / checks.sh.
#
# Scenario scripts call BARE commands: `file-exists`, `git-count`, `not`,
# `check-transcript`, `setup-helpers`, … This file is SOURCED before each
# scenario script so those names resolve to shell functions that delegate
# straight to the TypeScript dispatchers.
#
# It is path-free: every function reads $QUORUM_REPO_ROOT at call time, so the
# prelude can be sourced from anywhere (runPhase's bash -c, setup.sh's BASH_ENV).
#
# Each FS verb execs src/cli/check-tool.ts with its name as $1; that dispatcher
# is the sole source of the emitted {check,args,negated,passed,detail} record and
# the 127 crash-band exit discipline. `not` is also a check-tool.ts verb (its 3
# in-process rules live there). check-transcript and setup-helpers delegate to
# their own CLIs.

# Define one delegating function per FS check verb. The verb vocabulary is read
# from the dispatcher (Object.keys(FS_VERBS)) so it can never drift from the
# source of truth. `eval` here builds the function body once per verb name.
for __quorum_verb in $(bun run "$QUORUM_REPO_ROOT/src/cli/list-check-verbs.ts"); do
  eval "$__quorum_verb() { bun run \"\$QUORUM_REPO_ROOT/src/cli/check-tool.ts\" $__quorum_verb \"\$@\"; }"
done
unset __quorum_verb

# `not <inner> [args...]` — also a check-tool.ts verb (handled in-process there,
# with the 3 load-bearing negation rules). Defined explicitly because it is not
# in FS_VERBS.
not() { bun run "$QUORUM_REPO_ROOT/src/cli/check-tool.ts" not "$@"; }

# check-transcript <verb> [args...] — the trace-check CLI.
check-transcript() { bun run "$QUORUM_REPO_ROOT/src/cli/check-transcript.ts" "$@"; }

# setup-helpers run <helper> [<helper>...] — the fixture-helper CLI (used by setup.sh).
setup-helpers() { bun run "$QUORUM_REPO_ROOT/src/setup-helpers/cli.ts" "$@"; }

# inject-user-preference "<text>" — append a user preference to the ambient
# instructions file the coding-agent-under-test honors (CLAUDE.md / AGENTS.md /
# GEMINI.md, resolved from QUORUM_CODING_AGENT). Used by user-override scenarios'
# setup.sh so they stay harness-agnostic. Errors loudly for an unmapped agent.
inject-user-preference() { bun run "$QUORUM_REPO_ROOT/src/cli/inject-user-preference.ts" "$@"; }
