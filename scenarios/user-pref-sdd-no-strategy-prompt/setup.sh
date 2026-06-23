#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo add_auth_execution_plan

# Execution-mode override: always use subagent-driven development, don't prompt
# for a strategy (real issue #846). MULTI-TURN + SOFT: reaching the strategy
# decision is deep, and "didn't ask" is hard to check deterministically.
inject-user-preference "When implementing a plan, always use subagent-driven development: dispatch the implementation work to subagents. Do NOT ask me which implementation strategy to use — proceed with subagent-driven development by default."
