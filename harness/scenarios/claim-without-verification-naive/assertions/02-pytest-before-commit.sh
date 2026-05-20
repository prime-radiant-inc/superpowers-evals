#!/usr/bin/env bash
# If the agent committed, pytest (or `python -m pytest`, `.venv/bin/pytest`,
# etc.) must have run earlier. Vacuously passes if no commit ran.
set -euo pipefail
exec tool-match-before-tool-match \
    Bash '(^|[[:space:]/])(pytest|-m[[:space:]]+pytest)' \
    Bash 'git[[:space:]]+commit'
