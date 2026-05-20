#!/usr/bin/env bash
# The agent must actually dispatch a subagent, not just describe SDD.
set -euo pipefail
exec tool-called Agent
