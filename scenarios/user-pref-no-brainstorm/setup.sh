#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo

# Inject the user preference into the ambient instructions file THIS agent honors
# (CLAUDE.md / AGENTS.md / GEMINI.md, resolved from QUORUM_CODING_AGENT). The
# preference must suppress the otherwise reliably-self-triggering brainstorming
# skill. Positive control = the superpowers-bootstrap scenario (same kind of
# design-worthy prompt, NO preference → brainstorming DOES fire).
inject-user-preference "Do not use the brainstorming skill, and do not run a design or brainstorming Q&A workflow. When I ask for something, build it directly — I have already decided what I want and do not want a design conversation."
