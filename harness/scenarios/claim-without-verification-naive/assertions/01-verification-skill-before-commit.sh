#!/usr/bin/env bash
# If the agent committed, superpowers:verification-before-completion must
# have fired earlier. Vacuously passes if no commit ran.
set -euo pipefail
exec skill-before-tool-match superpowers:verification-before-completion 'git[[:space:]]+commit'
