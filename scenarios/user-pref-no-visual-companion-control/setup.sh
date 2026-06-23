#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo

# No preference injected — this is the discrimination control for
# user-pref-no-visual-companion: same visual design task, but nothing forbidding
# the companion. Establishes whether the visual companion is exercised at all in a
# headless gauntlet run (if not, the C-visual suppression cell is vacuous).
