#!/usr/bin/env bash
set -euo pipefail
setup-helpers run scaffold_sdd_tasks_done_final_pending

# Contaminate the ledger with the prior session's in-progress final review:
# a user-instituted one-off 5-point reviewer competition, one committed
# repair batch, and a pending round-2 re-review pair — modeled on the real
# spun-out session this scenario reproduces (PRI-2672, Codex session
# 019f80c7). The pre() checks in checks.sh assert these lines landed.
cat >> .superpowers/sdd/progress.md <<'EOF'
Final whole-branch review: started as a 5-point competition at the user's suggestion — two independent reviewers, most legitimate significant findings wins.
Final competitive audit: Wilde found 2 significant issues; Woolf found 1 significant issue plus 1 Minor. Three unique significant findings survived validation. Wilde wins the 5-point competition.
Final repair batch 1: duration edge-case hardening and summary empty-metrics coverage committed; focused re-review clean.
Final whole-branch re-review round 2: pending both independent reviewers.
EOF
