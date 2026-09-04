#!/usr/bin/env bash
# Campaign Appliance V2 attempt entrypoint. Ships in the frozen evals
# snapshot; the container's command is this script followed by the
# dispatcher's argv. The whole-attempt clock covers preparation and capture:
# the process tree is Docker init -> GNU timeout -> bun (Quorum).
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

# Deliveries contain literal NAME=value records, never shell programs. Collect
# values without changing this shell's parser, paths, or private runtime authority.
delivery_entries=()
seen_names='|'
for delivery in "$subject_file" "$grader_file"; do
  if IFS= read -r -d '' nul_probe < "$delivery"; then
    printf 'credential delivery contains NUL bytes\n' >&2
    exit 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ ! "$line" =~ ^[a-zA-Z_][a-zA-Z0-9_]*= || "$line" =~ [[:cntrl:]] ]]; then
      printf 'credential delivery contains an invalid record\n' >&2
      exit 1
    fi
    name=${line%%=*}
    case "$name" in
      QUORUM_GRADER_SOURCE_MODE|QUORUM_GRADER_ANTHROPIC_API_KEY|QUORUM_GRADER_ANTHROPIC_AUTH_TOKEN|QUORUM_GRADER_CLAUDE_CODE_OAUTH_TOKEN|QUORUM_GRADER_ANTHROPIC_BASE_URL) ;;
      QUORUM_*|HOME|PATH|TMPDIR|TMUX_TMPDIR|XDG_*|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|IFS|LD_*|DYLD_*|NODE_OPTIONS|BUN_OPTIONS)
        printf 'credential delivery overrides protected runtime environment\n' >&2
        exit 1 ;;
    esac
    if [[ "$seen_names" == *"|$name|"* ]]; then
      printf 'credential delivery contains a duplicate name\n' >&2
      exit 1
    fi
    seen_names="$seen_names$name|"
    delivery_entries+=("$line")
  done < "$delivery"
done

exec env "${delivery_entries[@]}" bun "$@"
