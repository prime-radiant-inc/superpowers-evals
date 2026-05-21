#!/usr/bin/env bash
# The run must have used the native Superpowers plugin hook in an
# isolated CODEX_HOME, not the legacy .agents symlink.
set -euo pipefail
exec codex-native-hook-configured
