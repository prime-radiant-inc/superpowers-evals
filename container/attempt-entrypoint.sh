#!/usr/bin/env bash
# Campaign Appliance V2 attempt entrypoint. Ships in the frozen evals
# snapshot; the container's command is this script followed by the
# dispatcher's argv. PID 1 is Docker's bundled init; after the exec below
# the tree is init -> bun (Quorum).
set -euo pipefail

umask 077

: "${QUORUM_ATTEMPT_DIR:?QUORUM_ATTEMPT_DIR is required}"

require_absolute_path() {
  local path=$1
  local name=$2
  if [[ "$path" != /* ]]; then
    printf '%s must be an absolute path\n' "$name" >&2
    exit 1
  fi
}

require_absolute_path "$QUORUM_ATTEMPT_DIR" QUORUM_ATTEMPT_DIR
if [[ -L "$QUORUM_ATTEMPT_DIR" || ! -d "$QUORUM_ATTEMPT_DIR" ]]; then
  printf 'QUORUM_ATTEMPT_DIR must be a real directory\n' >&2
  exit 1
fi

stdout_log=$QUORUM_ATTEMPT_DIR/stdout.log
stderr_log=$QUORUM_ATTEMPT_DIR/stderr.log
for log in "$stdout_log" "$stderr_log"; do
  if [[ -L "$log" || ! -f "$log" ]]; then
    printf 'attempt log must be a regular, pre-created file: %s\n' "$log" >&2
    exit 1
  fi
done

subject_file=${QUORUM_SUBJECT_FILE:-/run/quorum/subject.env}
grader_file=${QUORUM_GRADER_FILE:-/run/quorum/grader.env}
for delivery in "$subject_file" "$grader_file"; do
  require_absolute_path "$delivery" 'credential delivery'
  if [[ -L "$delivery" || ! -f "$delivery" || ! -r "$delivery" ]]; then
    printf 'credential delivery must be a readable, regular, non-symlink file: %s\n' "$delivery" >&2
    exit 1
  fi
done

# The controller created both logs mode 0600 before docker start; the
# entrypoint only appends, never creates or truncates.
exec >> "$stdout_log" 2>> "$stderr_log"

# Deliveries are controller-written NAME=value files, mode 0400. Shell
# sourcing is the deliberate child-1 model (the Phase 1 shim does the same
# with /run/evals/credentials.env); child 4 replaces it with non-shell
# parsing.
for delivery in "$subject_file" "$grader_file"; do
  set -a
  # shellcheck disable=SC1090
  source "$delivery"
  set +a
done

exec bun "$@"
