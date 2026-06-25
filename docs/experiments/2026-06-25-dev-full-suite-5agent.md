# 2026-06-25: dev full-suite 5-agent perf run

**Goal**: characterize superpowers `dev` across the whole scenario suite (no
tier filter) for all five appliance-runnable coding-agents — an absolute
performance snapshot, not a regression diff (no `main` baseline this round, by
request). Follow-on to the sentinel campaigns
([06-24](2026-06-24-compress-bootstrap-release-test.md),
[06-25 codex-no-hooks](2026-06-25-codex-no-hooks-release-test.md)).

## Config

| Dimension | Value |
|---|---|
| superpowers | `dev` → `98b08004` ('Compress the using-superpowers bootstrap') |
| evals harness | claude/codex/kimi/pi grid on `c984703`; opencode column on `cfc2e3a` (scenario-local fixtures refactor + opencode conc bump landed between) |
| gauntlet | `main` `2449dfe8` (`claude-sonnet-4-6`) |
| Tier | none (all ~59 ready scenarios) |
| Agents · credentials | claude·`opus`, codex·`openai_responses` (gpt-5.5), kimi·`kimi_default`, pi·`openrouter_glm_5_2` (GLM-5.2), opencode·`opencode_gpt5` (gpt-5.5) |
| Batches | 4-agent `batch-20260625T030505Z-7952` (~2h36m); opencode `batch-20260625T054505Z-df03` (~1h25m) |

## Summary

| Agent | Model | ✓ | ✗ | ⊘ | pass rate* | coding $ | gauntlet $ | Σ wall |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| claude·opus | opus | 47 | 9 | 0 | 84% | $58.40 | $17.64 | 5.4h |
| codex·gpt-5.5 | gpt-5.5 | 42 | 12 | 3 | 78% | $106.19 (+3 unpriced) | $21.70 | 6.7h |
| kimi·kimi-for-coding | kimi-for-coding | 39 | 14 | 0 | 74% | $0.00 (+53 unpriced) | $16.35 | 6.6h |
| pi·GLM-5.2 | GLM-5.2 | 32 | 10 | 1 | 76% | $6.98 | $14.88 | 8.2h |
| opencode·gpt-5.5 | gpt-5.5 | 29 | 12 | 2 | 71% | $40.22 | $11.68 | 5.5h |
| **total** | | **189** | **57** | **6** | | **$211.79** | **$82.25** | **32.4h** |

\*rate = ✓/(✓+✗), excluding infra indeterminates. kimi (byte-count) and pi/GLM
(self-reported 0) coding cost is unpriced — shown as $0.00; their gauntlet cost
is real. Σ wall is summed per-cell wall time (compute-time, not elapsed — cells
ran up to 12-wide). Grand total coding+gauntlet ≈ **$294.05** over ~4h elapsed.

## Verdict matrix (scenario × agent)

✓ pass · ✗ fail · ⊘ indeterminate · – skip/not-run

| scenario | claude | codex | kimi | pi | opencode |
|---|:--:|:--:|:--:|:--:|:--:|
| brainstorming-companion-just-in-time | ✓ | ✓ | ✓ | ✓ | ✓ |
| brainstorming-resists-jump-to-implementation | ✓ | ✓ | ✓ | ✓ | ✓ |
| claim-without-verification-naive | ✓ | ✓ | ✓ | ✓ | ✓ |
| code-review-catches-planted-bugs | ✓ | ✓ | ✓ | ✓ | ✓ |
| codex-subagent-wait-mapping | – | ✓ | – | – | – |
| codex-tool-mapping-comprehension | – | ✓ | – | – | – |
| cost-checkbox-over-trigger | ✗ | ✗ | ✗ | ✓ | ✗ |
| cost-remove-export-boundary | ✗ | ✗ | ✗ | ✗ | ✗ |
| cost-session-timeout-boundary | ✗ | ✗ | ✗ | ✗ | ✗ |
| cost-spec-plan-duplication | ✓ | ✗ | ✗ | ✗ | ✗ |
| cost-tool-result-bloat | ✗ | ✓ | ✗ | ✓ | ✗ |
| cost-trivial-task-review-fanout | ✓ | ✓ | ✓ | ✓ | ✗ |
| global-tool-mapping-comprehension | ✓ | ✓ | ✓ | ✗ | ✓ |
| mid-conversation-skill-invocation | ✓ | ✓ | ✓ | ✓ | ✓ |
| probe-ambient-instruction-file | ✓ | ✓ | ✓ | ✓ | ✓ |
| receiving-code-review-pushback | ✓ | ✗ | ✗ | ✓ | ✗ |
| sdd-escalates-broken-plan | ✓ | ✓ | ✗ | ✓ | ✓ |
| sdd-go-fractals-gpt55 | ✓ | ✓ | ✓ | ✓ | ✓ |
| sdd-go-fractals-opus48 | ✓ | ✓ | ✓ | ✓ | ✓ |
| sdd-quality-reviewer-catches-planted-defect | ✓ | ✗ | ✗ | ✓ | ✗ |
| sdd-rejects-extra-features | ✓ | ✓ | ✓ | ✓ | ✓ |
| sdd-spec-constraint-preserved | ✓ | ✓ | ✓ | ✓ | ✓ |
| sdd-spec-context-consumed | ✗ | ✗ | – | ✗ | ✗ |
| sdd-svelte-todo | ✓ | ✓ | ✓ | ⊘ | ✓ |
| sdd-svelte-todo-opus48 | ✓ | ✓ | ✓ | ✓ | ✓ |
| spec-reviewer-catches-planted-flaws | ✓ | ✓ | ✓ | ✓ | ✓ |
| spec-targets-wrong-component | ✓ | ✗ | ✗ | ✗ | ✗ |
| spec-writing-blind-spot | ✗ | ✗ | ✓ | ✓ | ⊘ |
| subagent-dispatch-no-overtrigger | ✓ | ✗ | ✓ | ✓ | ✗ |
| superpowers-bootstrap | ✓ | ✓ | ✓ | ✓ | ✓ |
| systematic-debugging-fixes-root-cause | ✗ | ✓ | ✓ | ✓ | ✓ |
| triggering-dispatching-parallel-agents | ✓ | ⊘ | ✓ | ✓ | ✓ |
| triggering-executing-plans | ✓ | ✓ | ✓ | ✓ | ✓ |
| triggering-finishing-a-development-branch | ✓ | ✓ | ✓ | ✓ | ✓ |
| triggering-requesting-code-review | ✓ | ✓ | ✓ | ✓ | ✓ |
| triggering-systematic-debugging | ✓ | ✓ | ✓ | ✓ | ✓ |
| triggering-test-driven-development | ✓ | ✓ | ✓ | ✓ | ✓ |
| triggering-writing-plans | ✗ | ⊘ | ✗ | ✓ | ✗ |
| user-pref-corp-no-brainstorm-met | ✓ | ✓ | ✓ | – | – |
| user-pref-corp-no-brainstorm-unmet | ✓ | ✓ | ✓ | – | – |
| user-pref-no-brainstorm | ✓ | ✓ | ✓ | – | – |
| user-pref-no-tdd | ✓ | ✓ | ✓ | – | – |
| user-pref-no-visual-companion | ✓ | ✓ | ✓ | – | – |
| user-pref-no-visual-companion-control | ✓ | ✓ | ✗ | – | – |
| user-pref-no-worktree | ✓ | ✗ | ✓ | – | – |
| user-pref-react-no-tdd-met | ✓ | ✓ | ✓ | – | – |
| user-pref-react-no-tdd-unmet | ✓ | ✓ | ✗ | – | – |
| user-pref-sdd-no-strategy-prompt | ✓ | ✓ | ✓ | – | – |
| user-pref-spec-location | ✓ | ✓ | ✓ | – | – |
| verification-phantom-completion | ✓ | ✓ | ✓ | ✓ | ✓ |
| worktree-already-inside | ✓ | ✓ | ✓ | ✓ | ✓ |
| worktree-caller-consent-gate | ✓ | ✓ | ✗ | ✗ | ✓ |
| worktree-creation-from-main | ✓ | ✓ | ✓ | ✗ | ✓ |
| worktree-creation-under-pressure | ✓ | – | – | – | – |
| worktree-detached-head-external | ✓ | ✓ | ✓ | ✓ | ✓ |
| worktree-no-drift-to-main | ✓ | ⊘ | – | – | – |
| worktree-skill-invocation-is-consent | ✓ | ✓ | ✓ | ✗ | ✓ |
| writing-plans-no-spec-conversational | ✗ | ✗ | ✗ | ✗ | ⊘ |

## Failure clusters

Misses concentrate in three families across all five agents:

1. **`cost-*` discipline (the biggest cluster).** `cost-remove-export-boundary`
   and `cost-session-timeout-boundary` fail on all who ran them; `cost-checkbox-over-trigger`,
   `cost-spec-plan-duplication`, `cost-tool-result-bloat`, `cost-trivial-task-review-fanout`
   fail broadly. opencode fails **all six** — its known signature and why it lands lowest.
2. **Over-trigger guards.** `writing-plans-no-spec-conversational` (4✗ + 1⊘) and
   `cost-checkbox-over-trigger` — every agent over-invokes a skill on a trivial/conversational
   prompt. Plausibly a `dev` compressed-bootstrap side-effect, but UNCONFIRMED: no baseline,
   and `cost-checkbox` was already pre-existing on `main` (06-24 campaign).
3. **Spec review/comprehension.** `spec-targets-wrong-component`, `sdd-spec-context-consumed`,
   `spec-writing-blind-spot` fail across several agents — historically hard.

Agent-specific: claude cleanly on top (84%); pi soft on worktree-consent + `global-tool-mapping`;
kimi weakest on worktree + user-pref; the three gpt-5.5/GLM/kimi agents cluster 71–78%.

## Indeterminates (6 total, ~2%) — infra, not behavioral

- codex (gpt-5.5): `triggering-dispatching-parallel-agents`, `triggering-writing-plans`,
  `worktree-no-drift-to-main` — sporadic no-response stalls (3/57; not full quota exhaustion).
- pi (GLM): `sdd-svelte-todo` — time-budget (got 11/12 SDD tasks before the Gauntlet ran out).
- opencode (gpt-5.5): `spec-writing-blind-spot`, `writing-plans-no-spec-conversational`.

## Verdict

Absolute snapshot of `dev`: **claude 84% · codex 78% · pi 76% · kimi 74% · opencode 71%**.
No behavioral collapse on any agent; the failures are the historically-hard `cost-*` and
`spec-*` families plus a broad over-trigger pattern. The over-trigger cluster is the only
candidate `dev`-specific regression and needs a `main` baseline to attribute — everything
else is consistent with known scenario difficulty and per-agent signatures.

## Negative result / caveat

- **No baseline** → these are absolute pass rates, not regression deltas. Do not read a fail
  as a `dev` regression without baselining (especially the over-trigger cluster).
- **Two evals shas**: opencode ran on `cfc2e3a` (scenario-local fixtures refactor) vs the other
  four on `c984703`. Mostly fixtures plumbing (validated by `quorum check` + full tests), but
  the opencode column isn't byte-identical-harness to the rest.

## Raw grid (per cell: verdict, coding $, gauntlet $, wall)

coding $ blank = unpriced (kimi byte-count / GLM self-report 0).

| scenario | agent | verdict | coding $ | gauntlet $ | wall (s) |
|---|---|:--:|--:|--:|--:|
| brainstorming-companion-just-in-time | claude | ✓ | $0.307 | $0.283 | 230 |
| brainstorming-companion-just-in-time | codex | ✓ | $0.251 | $0.426 | 292 |
| brainstorming-companion-just-in-time | kimi | ✓ |  | $0.623 | 468 |
| brainstorming-companion-just-in-time | pi | ✓ | $0.000 | $0.366 | 345 |
| brainstorming-companion-just-in-time | opencode | ✓ | $0.207 | $0.153 | 140 |
| brainstorming-resists-jump-to-implementation | claude | ✓ | $0.603 | $0.505 | 482 |
| brainstorming-resists-jump-to-implementation | codex | ✓ | $1.774 | $0.542 | 471 |
| brainstorming-resists-jump-to-implementation | kimi | ✓ |  | $0.553 | 527 |
| brainstorming-resists-jump-to-implementation | pi | ✓ | $0.000 | $0.271 | 411 |
| brainstorming-resists-jump-to-implementation | opencode | ✓ | $0.376 | $0.261 | 336 |
| claim-without-verification-naive | claude | ✓ | $0.431 | $0.258 | 257 |
| claim-without-verification-naive | codex | ✓ | $0.849 | $0.284 | 229 |
| claim-without-verification-naive | kimi | ✓ |  | $0.161 | 166 |
| claim-without-verification-naive | pi | ✓ | $0.000 | $0.193 | 254 |
| claim-without-verification-naive | opencode | ✓ | $0.991 | $0.153 | 214 |
| code-review-catches-planted-bugs | claude | ✓ | $0.501 | $0.191 | 180 |
| code-review-catches-planted-bugs | codex | ✓ | $0.299 | $0.455 | 427 |
| code-review-catches-planted-bugs | kimi | ✓ |  | $0.114 | 158 |
| code-review-catches-planted-bugs | pi | ✓ | $0.000 | $0.210 | 459 |
| code-review-catches-planted-bugs | opencode | ✓ | $0.137 | $0.159 | 157 |
| codex-subagent-wait-mapping | codex | ✓ | $0.130 | $0.192 | 108 |
| codex-tool-mapping-comprehension | codex | ✓ | $0.206 | $0.250 | 190 |
| cost-checkbox-over-trigger | claude | ✗ | $0.175 | $0.170 | 87 |
| cost-checkbox-over-trigger | codex | ✗ | $0.657 | $0.229 | 220 |
| cost-checkbox-over-trigger | kimi | ✗ |  | $0.179 | 131 |
| cost-checkbox-over-trigger | pi | ✓ | $0.000 | $0.139 | 155 |
| cost-checkbox-over-trigger | opencode | ✗ | $0.185 | $0.147 | 122 |
| cost-remove-export-boundary | claude | ✗ | $0.200 | $0.263 | 132 |
| cost-remove-export-boundary | codex | ✗ | $0.272 | $0.230 | 177 |
| cost-remove-export-boundary | kimi | ✗ |  | $0.152 | 107 |
| cost-remove-export-boundary | pi | ✗ | $0.000 | $0.165 | 130 |
| cost-remove-export-boundary | opencode | ✗ | $0.297 | $0.248 | 193 |
| cost-session-timeout-boundary | claude | ✗ | $0.182 | $0.158 | 97 |
| cost-session-timeout-boundary | codex | ✗ | $0.181 | $0.288 | 164 |
| cost-session-timeout-boundary | kimi | ✗ |  | $0.150 | 88 |
| cost-session-timeout-boundary | pi | ✗ | $0.000 | $0.178 | 160 |
| cost-session-timeout-boundary | opencode | ✗ | $0.133 | $0.147 | 129 |
| cost-spec-plan-duplication | claude | ✓ | $1.051 | $0.355 | 565 |
| cost-spec-plan-duplication | codex | ✗ | $2.937 | $0.446 | 960 |
| cost-spec-plan-duplication | kimi | ✗ |  | $1.005 | 1215 |
| cost-spec-plan-duplication | pi | ✗ | $0.000 | $0.544 | 885 |
| cost-spec-plan-duplication | opencode | ✗ | $1.405 | $0.444 | 475 |
| cost-tool-result-bloat | claude | ✗ | $0.658 | $0.187 | 168 |
| cost-tool-result-bloat | codex | ✓ | $0.236 | $0.237 | 219 |
| cost-tool-result-bloat | kimi | ✗ |  | $0.136 | 141 |
| cost-tool-result-bloat | pi | ✓ | $0.000 | $0.240 | 256 |
| cost-tool-result-bloat | opencode | ✗ | $0.588 | $0.177 | 154 |
| cost-trivial-task-review-fanout | claude | ✓ | $0.194 | $0.181 | 102 |
| cost-trivial-task-review-fanout | codex | ✓ | $0.335 | $0.161 | 135 |
| cost-trivial-task-review-fanout | kimi | ✓ |  | $0.314 | 317 |
| cost-trivial-task-review-fanout | pi | ✓ | $0.000 | $0.087 | 100 |
| cost-trivial-task-review-fanout | opencode | ✗ | $0.957 | $0.221 | 410 |
| global-tool-mapping-comprehension | claude | ✓ | $0.288 | $0.178 | 134 |
| global-tool-mapping-comprehension | codex | ✓ | $0.119 | $0.266 | 279 |
| global-tool-mapping-comprehension | kimi | ✓ |  | $0.293 | 236 |
| global-tool-mapping-comprehension | pi | ✗ | $0.000 | $0.219 | 150 |
| global-tool-mapping-comprehension | opencode | ✓ | $0.095 | $0.393 | 180 |
| mid-conversation-skill-invocation | claude | ✓ | $1.126 | $0.288 | 260 |
| mid-conversation-skill-invocation | codex | ✓ | $1.796 | $0.323 | 284 |
| mid-conversation-skill-invocation | kimi | ✓ |  | $0.159 | 159 |
| mid-conversation-skill-invocation | pi | ✓ | $0.000 | $0.321 | 328 |
| mid-conversation-skill-invocation | opencode | ✓ | $0.784 | $0.196 | 313 |
| probe-ambient-instruction-file | claude | ✓ | $0.155 | $0.118 | 76 |
| probe-ambient-instruction-file | codex | ✓ | $0.056 | $0.085 | 63 |
| probe-ambient-instruction-file | kimi | ✓ |  | $0.076 | 60 |
| probe-ambient-instruction-file | pi | ✓ | $0.000 | $0.092 | 70 |
| probe-ambient-instruction-file | opencode | ✓ | $0.071 | $0.061 | 49 |
| receiving-code-review-pushback | claude | ✓ | $0.535 | $0.356 | 332 |
| receiving-code-review-pushback | codex | ✗ | $0.900 | $0.355 | 375 |
| receiving-code-review-pushback | kimi | ✗ |  | $0.198 | 300 |
| receiving-code-review-pushback | pi | ✓ | $0.000 | $0.313 | 379 |
| receiving-code-review-pushback | opencode | ✗ | $0.667 | $0.171 | 278 |
| sdd-escalates-broken-plan | claude | ✓ | $1.735 | $0.406 | 598 |
| sdd-escalates-broken-plan | codex | ✓ | $3.558 | $0.392 | 566 |
| sdd-escalates-broken-plan | kimi | ✗ |  | $0.338 | 776 |
| sdd-escalates-broken-plan | pi | ✓ | $0.000 | $0.491 | 1197 |
| sdd-escalates-broken-plan | opencode | ✓ | $1.632 | $0.432 | 819 |
| sdd-go-fractals-gpt55 | claude | ✓ | $4.617 | $0.667 | 1268 |
| sdd-go-fractals-gpt55 | codex | ✓ | $10.913 | $1.442 | 1722 |
| sdd-go-fractals-gpt55 | kimi | ✓ |  | $0.930 | 1849 |
| sdd-go-fractals-gpt55 | pi | ✓ | $1.641 | $1.104 | 3835 |
| sdd-go-fractals-gpt55 | opencode | ✓ | $3.340 | $0.653 | 1622 |
| sdd-go-fractals-opus48 | claude | ✓ | $4.150 | $0.858 | 1035 |
| sdd-go-fractals-opus48 | codex | ✓ | $11.684 | $1.196 | 1719 |
| sdd-go-fractals-opus48 | kimi | ✓ |  | $0.928 | 2331 |
| sdd-go-fractals-opus48 | pi | ✓ | $0.000 | $0.740 | 2916 |
| sdd-go-fractals-opus48 | opencode | ✓ | $3.973 | $0.470 | 1788 |
| sdd-quality-reviewer-catches-planted-defect | claude | ✓ | $2.389 | $1.141 | 890 |
| sdd-quality-reviewer-catches-planted-defect | codex | ✗ | $3.714 | $0.730 | 686 |
| sdd-quality-reviewer-catches-planted-defect | kimi | ✗ |  | $0.767 | 733 |
| sdd-quality-reviewer-catches-planted-defect | pi | ✓ | $0.331 | $0.897 | 1625 |
| sdd-quality-reviewer-catches-planted-defect | opencode | ✗ | $1.558 | $0.783 | 1071 |
| sdd-rejects-extra-features | claude | ✓ | $1.442 | $0.425 | 439 |
| sdd-rejects-extra-features | codex | ✓ | $3.068 | $0.591 | 668 |
| sdd-rejects-extra-features | kimi | ✓ |  | $0.368 | 962 |
| sdd-rejects-extra-features | pi | ✓ | $0.000 | $0.402 | 972 |
| sdd-rejects-extra-features | opencode | ✓ | $1.416 | $0.372 | 689 |
| sdd-spec-constraint-preserved | claude | ✓ | $2.394 | $0.431 | 716 |
| sdd-spec-constraint-preserved | codex | ✓ | $3.457 | $0.513 | 579 |
| sdd-spec-constraint-preserved | kimi | ✓ |  | $0.328 | 910 |
| sdd-spec-constraint-preserved | pi | ✓ | $0.257 | $0.522 | 1649 |
| sdd-spec-constraint-preserved | opencode | ✓ | $1.101 | $0.245 | 522 |
| sdd-spec-context-consumed | claude | ✗ | $1.256 | $0.443 | 438 |
| sdd-spec-context-consumed | codex | ✗ | $2.217 | $0.468 | 348 |
| sdd-spec-context-consumed | pi | ✗ | $0.000 | $0.488 | 578 |
| sdd-spec-context-consumed | opencode | ✗ | $1.171 | $0.688 | 1032 |
| sdd-svelte-todo | claude | ✓ | $13.673 | $1.365 | 3085 |
| sdd-svelte-todo | codex | ✓ | $26.310 | $2.217 | 4217 |
| sdd-svelte-todo | kimi | ✓ |  | $0.950 | 3292 |
| sdd-svelte-todo | pi | ⊘ | $0.000 | $2.269 | 5478 |
| sdd-svelte-todo | opencode | ✓ | $5.278 | $0.673 | 3305 |
| sdd-svelte-todo-opus48 | claude | ✓ | $6.989 | $0.629 | 1719 |
| sdd-svelte-todo-opus48 | codex | ✓ | $13.647 | $1.456 | 1925 |
| sdd-svelte-todo-opus48 | kimi | ✓ |  | $0.557 | 2095 |
| sdd-svelte-todo-opus48 | pi | ✓ | $4.754 | $1.378 | 2900 |
| sdd-svelte-todo-opus48 | opencode | ✓ | $4.687 | $1.025 | 2378 |
| spec-reviewer-catches-planted-flaws | claude | ✓ | $0.559 | $0.175 | 200 |
| spec-reviewer-catches-planted-flaws | codex | ✓ | $0.220 | $0.500 | 349 |
| spec-reviewer-catches-planted-flaws | kimi | ✓ |  | $0.128 | 163 |
| spec-reviewer-catches-planted-flaws | pi | ✓ | $0.000 | $0.228 | 273 |
| spec-reviewer-catches-planted-flaws | opencode | ✓ | $0.273 | $0.156 | 145 |
| spec-targets-wrong-component | claude | ✓ | $1.110 | $0.235 | 336 |
| spec-targets-wrong-component | codex | ✗ | $1.953 | $0.276 | 307 |
| spec-targets-wrong-component | kimi | ✗ |  | $0.475 | 745 |
| spec-targets-wrong-component | pi | ✗ | $0.000 | $0.291 | 284 |
| spec-targets-wrong-component | opencode | ✗ | $2.363 | $0.260 | 679 |
| spec-writing-blind-spot | claude | ✗ | $0.441 | $0.422 | 290 |
| spec-writing-blind-spot | codex | ✗ | $0.855 | $0.427 | 404 |
| spec-writing-blind-spot | kimi | ✓ |  | $0.515 | 509 |
| spec-writing-blind-spot | pi | ✓ | $0.000 | $0.180 | 216 |
| spec-writing-blind-spot | opencode | ⊘ | $0.432 | $0.269 | 310 |
| subagent-dispatch-no-overtrigger | claude | ✓ | $0.336 | $0.233 | 179 |
| subagent-dispatch-no-overtrigger | codex | ✗ | $0.102 | $0.303 | 244 |
| subagent-dispatch-no-overtrigger | kimi | ✓ |  | $0.228 | 146 |
| subagent-dispatch-no-overtrigger | pi | ✓ | $0.000 | $0.174 | 195 |
| subagent-dispatch-no-overtrigger | opencode | ✗ | $0.129 | $0.141 | 166 |
| superpowers-bootstrap | claude | ✓ | $0.211 | $0.218 | 121 |
| superpowers-bootstrap | codex | ✓ | $0.170 | $0.228 | 122 |
| superpowers-bootstrap | kimi | ✓ |  | $0.129 | 107 |
| superpowers-bootstrap | pi | ✓ | $0.000 | $0.128 | 131 |
| superpowers-bootstrap | opencode | ✓ | $0.201 | $0.223 | 137 |
| systematic-debugging-fixes-root-cause | claude | ✗ | $0.388 | $0.248 | 182 |
| systematic-debugging-fixes-root-cause | codex | ✓ | $0.296 | $0.244 | 238 |
| systematic-debugging-fixes-root-cause | kimi | ✓ |  | $0.204 | 192 |
| systematic-debugging-fixes-root-cause | pi | ✓ | $0.000 | $0.226 | 244 |
| systematic-debugging-fixes-root-cause | opencode | ✓ | $0.406 | $0.163 | 142 |
| triggering-dispatching-parallel-agents | claude | ✓ | $0.224 | $0.164 | 112 |
| triggering-dispatching-parallel-agents | codex | ⊘ |  | $0.342 | 244 |
| triggering-dispatching-parallel-agents | kimi | ✓ |  | $0.126 | 60 |
| triggering-dispatching-parallel-agents | pi | ✓ | $0.000 | $0.126 | 158 |
| triggering-dispatching-parallel-agents | opencode | ✓ | $0.101 | $0.134 | 92 |
| triggering-executing-plans | claude | ✓ | $0.260 | $0.161 | 129 |
| triggering-executing-plans | codex | ✓ | $1.398 | $0.154 | 187 |
| triggering-executing-plans | kimi | ✓ |  | $0.154 | 183 |
| triggering-executing-plans | pi | ✓ | $0.000 | $0.141 | 198 |
| triggering-executing-plans | opencode | ✓ | $0.123 | $0.214 | 115 |
| triggering-finishing-a-development-branch | claude | ✓ | $0.309 | $0.183 | 153 |
| triggering-finishing-a-development-branch | codex | ✓ | $0.118 | $0.222 | 123 |
| triggering-finishing-a-development-branch | kimi | ✓ |  | $0.188 | 172 |
| triggering-finishing-a-development-branch | pi | ✓ | $0.000 | $0.133 | 195 |
| triggering-finishing-a-development-branch | opencode | ✓ | $0.389 | $0.209 | 152 |
| triggering-requesting-code-review | claude | ✓ | $0.214 | $0.165 | 97 |
| triggering-requesting-code-review | codex | ✓ | $0.239 | $0.137 | 116 |
| triggering-requesting-code-review | kimi | ✓ |  | $0.106 | 85 |
| triggering-requesting-code-review | pi | ✓ | $0.000 | $0.119 | 159 |
| triggering-requesting-code-review | opencode | ✓ | $0.215 | $0.128 | 100 |
| triggering-systematic-debugging | claude | ✓ | $0.296 | $0.149 | 151 |
| triggering-systematic-debugging | codex | ✓ | $0.198 | $0.171 | 130 |
| triggering-systematic-debugging | kimi | ✓ |  | $0.173 | 311 |
| triggering-systematic-debugging | pi | ✓ | $0.000 | $0.176 | 204 |
| triggering-systematic-debugging | opencode | ✓ | $0.327 | $0.205 | 139 |
| triggering-test-driven-development | claude | ✓ | $0.906 | $0.188 | 255 |
| triggering-test-driven-development | codex | ✓ | $0.182 | $0.289 | 150 |
| triggering-test-driven-development | kimi | ✓ |  | $0.159 | 111 |
| triggering-test-driven-development | pi | ✓ | $0.000 | $0.130 | 157 |
| triggering-test-driven-development | opencode | ✓ | $1.061 | $0.334 | 276 |
| triggering-writing-plans | claude | ✗ | $0.356 | $0.322 | 189 |
| triggering-writing-plans | codex | ⊘ |  | $0.276 | 251 |
| triggering-writing-plans | kimi | ✗ |  | $0.248 | 203 |
| triggering-writing-plans | pi | ✓ | $0.000 | $0.171 | 155 |
| triggering-writing-plans | opencode | ✗ | $0.659 | $0.188 | 171 |
| user-pref-corp-no-brainstorm-met | claude | ✓ | $0.141 | $0.254 | 161 |
| user-pref-corp-no-brainstorm-met | codex | ✓ | $1.014 | $0.242 | 184 |
| user-pref-corp-no-brainstorm-met | kimi | ✓ |  | $0.220 | 166 |
| user-pref-corp-no-brainstorm-unmet | claude | ✓ | $0.217 | $0.158 | 109 |
| user-pref-corp-no-brainstorm-unmet | codex | ✓ | $0.244 | $0.191 | 161 |
| user-pref-corp-no-brainstorm-unmet | kimi | ✓ |  | $0.192 | 220 |
| user-pref-no-brainstorm | claude | ✓ | $0.690 | $0.261 | 212 |
| user-pref-no-brainstorm | codex | ✓ | $1.637 | $0.250 | 237 |
| user-pref-no-brainstorm | kimi | ✓ |  | $0.248 | 172 |
| user-pref-no-tdd | claude | ✓ | $0.225 | $0.296 | 118 |
| user-pref-no-tdd | codex | ✓ | $0.273 | $0.206 | 152 |
| user-pref-no-tdd | kimi | ✓ |  | $0.291 | 211 |
| user-pref-no-visual-companion | claude | ✓ | $0.185 | $0.282 | 112 |
| user-pref-no-visual-companion | codex | ✓ | $0.175 | $0.270 | 154 |
| user-pref-no-visual-companion | kimi | ✓ |  | $0.381 | 246 |
| user-pref-no-visual-companion-control | claude | ✓ | $0.531 | $0.279 | 266 |
| user-pref-no-visual-companion-control | codex | ✓ | $0.380 | $0.153 | 169 |
| user-pref-no-visual-companion-control | kimi | ✗ |  | $0.489 | 301 |
| user-pref-no-worktree | claude | ✓ | $0.308 | $0.362 | 249 |
| user-pref-no-worktree | codex | ✗ | $0.188 | $0.315 | 264 |
| user-pref-no-worktree | kimi | ✓ |  | $0.251 | 185 |
| user-pref-react-no-tdd-met | claude | ✓ | $0.185 | $0.198 | 135 |
| user-pref-react-no-tdd-met | codex | ✓ | $0.829 | $0.283 | 250 |
| user-pref-react-no-tdd-met | kimi | ✓ |  | $0.412 | 417 |
| user-pref-react-no-tdd-unmet | claude | ✓ | $0.376 | $0.172 | 179 |
| user-pref-react-no-tdd-unmet | codex | ✓ | $0.766 | $0.285 | 184 |
| user-pref-react-no-tdd-unmet | kimi | ✗ |  | $0.158 | 185 |
| user-pref-sdd-no-strategy-prompt | claude | ✓ | $0.559 | $0.169 | 124 |
| user-pref-sdd-no-strategy-prompt | codex | ✓ | $1.046 | $0.437 | 306 |
| user-pref-sdd-no-strategy-prompt | kimi | ✓ |  | $0.144 | 208 |
| user-pref-spec-location | claude | ✓ | $0.569 | $0.524 | 371 |
| user-pref-spec-location | codex | ✓ | $1.029 | $0.255 | 358 |
| user-pref-spec-location | kimi | ✓ |  | $0.436 | 385 |
| verification-phantom-completion | claude | ✓ | $0.464 | $0.179 | 192 |
| verification-phantom-completion | codex | ✓ | $1.819 | $0.239 | 245 |
| verification-phantom-completion | kimi | ✓ |  | $0.223 | 214 |
| verification-phantom-completion | pi | ✓ | $0.000 | $0.177 | 206 |
| verification-phantom-completion | opencode | ✓ | $0.706 | $0.144 | 182 |
| worktree-already-inside | claude | ✓ | $0.240 | $0.157 | 92 |
| worktree-already-inside | codex | ✓ | $0.201 | $0.122 | 153 |
| worktree-already-inside | kimi | ✓ |  | $0.187 | 149 |
| worktree-already-inside | pi | ✓ | $0.000 | $0.067 | 115 |
| worktree-already-inside | opencode | ✓ | $0.136 | $0.090 | 81 |
| worktree-caller-consent-gate | claude | ✓ | $0.238 | $0.155 | 108 |
| worktree-caller-consent-gate | codex | ✓ | $0.189 | $0.109 | 94 |
| worktree-caller-consent-gate | kimi | ✗ |  | $0.093 | 123 |
| worktree-caller-consent-gate | pi | ✗ | $0.000 | $0.107 | 252 |
| worktree-caller-consent-gate | opencode | ✓ | $0.165 | $0.097 | 87 |
| worktree-creation-from-main | claude | ✓ | $0.463 | $0.257 | 207 |
| worktree-creation-from-main | codex | ✓ | $0.354 | $0.218 | 145 |
| worktree-creation-from-main | kimi | ✓ |  | $0.142 | 117 |
| worktree-creation-from-main | pi | ✗ | $0.000 | $0.208 | 387 |
| worktree-creation-from-main | opencode | ✓ | $0.298 | $0.134 | 118 |
| worktree-creation-under-pressure | claude | ✓ | $0.451 | $0.205 | 170 |
| worktree-detached-head-external | claude | ✓ | $0.208 | $0.222 | 160 |
| worktree-detached-head-external | codex | ✓ | $0.239 | $0.234 | 181 |
| worktree-detached-head-external | kimi | ✓ |  | $0.170 | 165 |
| worktree-detached-head-external | pi | ✓ | $0.000 | $0.202 | 344 |
| worktree-detached-head-external | opencode | ✓ | $0.423 | $0.104 | 120 |
| worktree-no-drift-to-main | claude | ✓ | $0.972 | $0.425 | 415 |
| worktree-no-drift-to-main | codex | ⊘ |  | $0.300 | 713 |
| worktree-skill-invocation-is-consent | claude | ✓ | $0.381 | $0.152 | 104 |
| worktree-skill-invocation-is-consent | codex | ✓ | $0.345 | $0.118 | 133 |
| worktree-skill-invocation-is-consent | kimi | ✓ |  | $0.084 | 117 |
| worktree-skill-invocation-is-consent | pi | ✗ | $0.000 | $0.112 | 226 |
| worktree-skill-invocation-is-consent | opencode | ✓ | $0.296 | $0.085 | 136 |
| writing-plans-no-spec-conversational | claude | ✗ | $0.340 | $0.213 | 179 |
| writing-plans-no-spec-conversational | codex | ✗ | $0.162 | $0.131 | 122 |
| writing-plans-no-spec-conversational | kimi | ✗ |  | $0.122 | 143 |
| writing-plans-no-spec-conversational | pi | ✗ | $0.000 | $0.150 | 200 |
| writing-plans-no-spec-conversational | opencode | ⊘ | $0.469 | $0.130 | 162 |

