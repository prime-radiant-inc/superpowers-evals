# RED campaign recipe: codex-spinout fixes (PRI-2672)

- **Date authored:** 2026-07-22 (scenarios only — no campaign run yet)
- **Ticket:** PRI-2672 (Codex 5.6-era SDD spinout)
- **Scenario branch:** `codex-spinout-scenarios` (this repo)
- **Fix branch under test:** superpowers `codex-spinout-fixes` (consolidation of
  `exp/codex-spinout-surgical` @3921dc99 + `exp/codex-spinout-surgical-v2`
  @d123bde4 — in preparation), vs baseline dev@cc690476
- **Field evidence being formalized:** two manual Codex App runs (2026-07-21,
  sessions 019f8634 / 019f865d) — run 1 finished the spun-out S2 final review
  in 81 min; run 2 finished the spun-out S1 plan end-to-end; dispatch
  compliance went 0/2 → 5/5+ at post-compaction boundaries after the v2
  script-tuple swap. Full accounting in PRI-2672 comments.

## New scenarios

| Scenario | Backend | Fixture | RED expectation vs dev@cc690476 | GREEN gate vs fix branch |
|---|---|---|---|---|
| `sdd-codex-dispatch-pinning` | codex (0.145+ REQUIRED) | `scaffold_sdd_midloop_round1` | FAIL: dev codex-tools.md has no dispatch rules; observed live behavior omits model/effort (inherits parent frontier config) and omits fork_turns (defaults to full-history "all") | PASS: every dispatch pins fork_turns:"none" + role-table model/effort |
| `sdd-codex-no-tier-escalation` | codex (0.145+ REQUIRED) | `scaffold_sdd_midloop_round3` | FAIL: dev SKILL.md "at least one tier above" reads, on Codex, as a climb to gpt-5.6-sol (or silent frontier inheritance) at round 4 | PASS: fresh implementer at terra/high, or BLOCKED escalation to the human |
| `sdd-final-review-contaminated-resume` | unpinned (run CC first; codex column optional) | `scaffold_sdd_tasks_done_final_pending` + contaminated-ledger tail (setup.sh) | PARTIAL RED expected: dev has single-wave text but no "wave closing is policy" / competition-non-adoption language; the real S2 session re-adopted the ledger's competition and looped 3h+. Probabilistic — treat ≥1/3 fails as RED confirmation | PASS: at most one bounded cycle, residuals dispositioned, no competition re-adoption |

## Campaign plan

1. **Columns:** codex `openai_responses_56sol`-style credential for the two
   codex scenarios (parent at sol max/xhigh reproduces the inheritance
   hazard); CC `opus`/`fable` for `sdd-final-review-contaminated-resume`.
2. **Reps:** 3 per cell. These are behavior-distribution scenarios, not
   deterministic bugs — grade RED on the pattern (any structural violation in
   3 reps), not a single rep.
3. **RED first** against superpowers dev@cc690476, then **GREEN** against
   `codex-spinout-fixes` with identical cells. Do not iterate wording
   mid-campaign; a wording change restarts the affected cells.
4. **CC regression guards** (must stay green on the fix branch — these
   verify the platform-override qualifier does not damage CC behavior):
   - `sdd-round4-escalates-model` (claude-pinned — the CC escalation ladder
     the Codex table deliberately overrides; the single most important guard)
   - `sdd-final-review-single-wave` (the clean-resume final-review contract)
   - `sdd-fix-loop-resumes-implementer`, `sdd-re-review-scoped`
   - `sdd-breaker-adjudicates-at-cap`, `sdd-breaker-structural-blocks`
   - `sdd-escalates-broken-plan` (E35 guard: plan-mandated defect escalation)
   - `sdd-quality-reviewer-catches-planted-defect` (recall guard; note its
     PRI-2590 `command-succeeds` leftover needs one live re-run to settle)
   - `sdd-rejects-extra-features`, `sdd-same-plan-resume`

## Container prerequisites (BLOCKING for the two codex scenarios)

1. **codex version:** `container/Dockerfile:89` pins `@openai/codex@0.144.4`,
   whose `spawn_agent` schema has NO `model`/`reasoning_effort` parameters
   (verified live 2026-07-21: schema is exactly `{task_name, message,
   fork_turns?}`; children always inherit the parent tier). Both codex
   scenarios grade wrong there — bump the pin to **0.145.0** (npm `latest`
   as of 2026-07-21; spawn allowlist {gpt-5.6-sol, gpt-5.6-terra}, efforts
   low..ultra, `fork_turns:"all"` forks reject overrides) and rebuild.
2. **multi_agent:** the staged cell config must set
   `[features] multi_agent = true` (not currently present in
   `coding-agents/codex-context/`); without it there is no spawn_agent at
   all. Also confirm `[agents] max_threads` default suffices (8 is fine).
3. **max_time:** `coding-agents/codex.yaml` defaults `max_time: 10m`; the
   scenario frontmatter sets `quorum_max_time: 60m` — confirm the scenario
   value wins for these cells (it does for the existing 60m SDD scenarios).
4. **Normalizer shape risk:** deterministic matchers use comma-fallback keys
   (`model,input,prompt=…`) to survive both the direct-tool-call and
   unified-`exec` rollout shapes (PRI-2584). If a 0.145 rollout introduces a
   third shape, re-characterize before trusting the deterministic layer —
   the Gauntlet-Agent judge criteria are authoritative either way.

## Open feasibility risks

- The 0.145 container bump is untested — the PRI-2584 normalizer fix was
  validated against 0.144.3 rollouts; a quick `triggering-test-driven-
  development` smoke cell on 0.145 should precede the campaign.
- `sdd-final-review-contaminated-resume` appends its ledger tail in
  setup.sh (a deviation from the one-line-helper convention, chosen to
  avoid a src/setup-helpers change on a scenario branch); its pre() checks
  assert the appended lines so a cwd surprise fails loudly at fixture time.
  If maintainers prefer, fold the tail into a
  `scaffold_sdd_tasks_done_final_midwave` helper before merging.
- Judge-vs-deterministic split: the universal claims (EVERY dispatch pinned,
  NO sol dispatch, wave-count) are judge-owned; the deterministic layer is
  existential-only. This mirrors sdd-final-review-single-wave and is
  documented in each checks.sh.
