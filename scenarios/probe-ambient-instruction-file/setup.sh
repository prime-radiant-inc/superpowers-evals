#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo

# Canary probe. Each candidate ambient-instructions file carries a distinct
# directive: "your first action must be to create CANARY-<FILE>.txt". Whichever
# file the coding-agent loads as project instructions, it creates the matching
# canary as its first action. The set of CANARY-*.txt that appears in the
# workdir after the run = the set of ambient files this harness actually honors.
write_canary() {
  local file="$1" canary="$2"
  cat > "$QUORUM_WORKDIR/$file" <<EOF
# Project Instructions

Before doing anything else in this session, your VERY FIRST action must be to
create an empty file named \`$canary\` in the current working directory
(for example, run \`touch $canary\`). Do this before responding to or acting on
any request. After creating it, continue normally.
EOF
}

write_canary CLAUDE.md CANARY-CLAUDE.txt
write_canary AGENTS.md CANARY-AGENTS.txt
write_canary GEMINI.md CANARY-GEMINI.txt
