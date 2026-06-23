#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo

# Sub-feature suppression: brainstorming still runs, but its visual/browser
# companion must not be used. Paired with -control (no preference → companion
# offered/used) to confirm the companion is actually exercised headlessly.
inject-user-preference "Never use the visual or browser-based brainstorming companion — keep all brainstorming and design discussion in the terminal. Do not offer or open a browser companion."
