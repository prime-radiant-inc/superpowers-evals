# Skill-Edit Eval Campaign — PRs #1932–#1935 (2026-07-06)

Gates four superpowers skill-edit PRs through quorum before merge. Framed as a
**differential**: the question per PR is "did the targeted behavior survive the
edit," read as a pass-rate delta against a frozen control — not an absolute
pass. Enabled by the `superpowers_rev` provenance field (merged in PRI-2494),
which stamps the exact skills commit per run.

#1931 (agentic-end-to-end-testing, new skill) is **deferred** — its rider
branch `agentic-e2e-scenarios` is missing from origin and it is authoring-heavy;
handled as a separate follow-up once the branch question is settled.

## Locked decisions (Drew, 2026-07-06)

- **Skills ref: frozen.** Control baseline pinned; treatment arms are the four
  PR heads. Do not run against a moving `main`.
- **Reps: n≥5 on the prose bets** (#1934 verification/TDD, #1935 anti-mock),
  n≥3 on other probabilistic probes (triggering-*/user-pref), n=1 only on
  deterministic file/git-state checks. Codex as a low-rep determinate
  cross-check.
- **#1934 bets: dedicated differential probes** (with/without-prose pressure
  scenarios) authored up front — SUP-333 showed absolute pass-rate HIDES a
  non-load-bearing rebuttal, so a differential is mandatory, not conditional.
- **#1931: deferred.**

## Pinned refs

| Arm | Ref | SHA |
|---|---|---|
| CONTROL (frozen baseline) | superpowers v6.1.0 = the four PRs' common fork point | `f268f7c953744036f0fa7e9d4b73535c04e57cb8` |
| #1932 treatment | `integration-section-cleanup` | `67f513f3468ad2f7dd2d05ed95ce70fce3156e1d` |
| #1933 treatment | `finishing-branch-cleanup` | `94dc995719bd02744037ab97b86cc467c3b16790` |
| #1934 treatment | `skill-detritus-cleanup` | `91eba77cf1590926ec9ba9ab3543223fc5a72928` |
| #1935 treatment | `tdd-writing-good-tests` | `0e69a4d32c2db00ebc012310d303907cc5507c6f` |

Harness (superpowers-evals) at campaign start: `818b975` (PRI-2494 merged).
Appliance container CLIs (held constant, asserted via provenance per run):
claude 2.1.181, codex-cli 0.140.0. Gauntlet-Agent model: claude-sonnet-4-6.
Codex credential on the appliance: `openai_responses` (subscription auth not
seeded); claude: `opus`.

**Agent-CLI refresh (2026-07-07, before the full proving run).** All appliance
agent CLIs bumped to latest and the previously-floating npm pins frozen
(container/Dockerfile): claude 2.1.181→2.1.202, codex 0.140→0.142.5, gemini
0.47→0.49, kimi 0.15→0.23.1, pi 0.80.1→0.80.3, pi-subagents 0.28→0.34, goose
1.31.1→1.41.0, serf `main`→pinned SHA, plus opencode/copilot/qwen/kilo/
openclaw/amp/cline/grok pinned to their current latest (PRI-2493
unpinned-instrument finding). **This resets CLI-constancy**: the frozen control
baseline + #1932 claude arm ran on claude 2.1.181 and MUST be re-baselined on
2.1.202 before their differentials are read against later arms. Installer-based
CLIs (cursor-agent, hermes, mimo, sweagent, trae, mini-swe-agent) still float to
latest at build time — pinning them is a follow-up.

**Standing practice (Drew, 2026-07-07): before any big proving run, bump all
harness CLIs to their latest versions and rebuild the appliance image**, then
re-establish the control baseline on the refreshed image. A proving run is only
as current as its instruments; stale CLIs make the verdict about an old agent.
Record the exact resolved versions (provenance stamps them per run) so the
proving run is reproducible.

**Control-ref correction (2026-07-06, during baseline shakedown).** The control
was originally pinned to `d884ae04` (v6.1.1, `origin/main` at campaign start).
Two findings forced the move to `f268f7c9` (v6.1.0):
1. All four PR branches share merge-base `f268f7c9` (verified per head). The 10
   commits `f268f7c9..d884ae04` touch **zero `skills/` files** (verified:
   `git diff --name-only -- skills/` is empty) — they are Codex packaging work.
   So v6.1.0 and v6.1.1 are content-identical on the measured surface, and the
   fork point removes the fork-point confound entirely.
2. `d884ae04` **deleted `hooks/session-start-codex`** (the Codex portal
   packaging rework), and codex provisioning at that ref fails setup with
   "Expected one Superpowers Codex SessionStart hook, found 0" — every codex
   cell burned as an infrastructure indeterminate. At `f268f7c9` the hook
   exists and codex cells run.
Branch topology note (methodology review): the PRs target `dev`, not `main`;
`dev` and `main` are content-equivalent on `skills/` (zero files differ between
their HEADs) — parallel histories from a cherry-pick/rebuild at `f268f7c9`. Not
a confound while both stay frozen for the campaign.

## Hypotheses (per PR)

- **#1932** (relocate sole-carrier requirements to point-of-use): H0 = no
  behavioral change; agents still establish a worktree before task 1 and still
  invoke verification-before-completion after a fix. Pure regression net.
- **#1933** (finishing-a-development-branch): the WORKTREE_PATH-before-cd fix
  makes worktree cleanup actually happen (deterministic); discard is demoted to
  explicit-typed-request only; menu is 3 options (2 detached).
- **#1934** (strip motivational prose from 12 skills): H0 = the removed prose
  was NOT load-bearing (behavior holds without it) — SUP-333 prior. Two bets
  (verification-before-completion, TDD) get with/without differential probes.
- **#1935** (writing-good-tests positive reframe): H0 = the positive frame holds
  the anti-mock line under time pressure as well as the prohibition frame did.
  Note: adds new doctrine (Principle 1 falsifiability + Mutation Check) with no
  antecedent — over-correction (deleting legit tests as "change detectors") is a
  distinct risk.

## Pre-registered decision rules (locked 2026-07-06, BEFORE any treatment data)

From the three-reviewer pass (methodology / feasibility / adversarial validity).
These rules are fixed now so verdicts cannot be post-hoc rationalized. n=3/n=5
sits at the floor of detectability (1 failure = 20–33% swing); the rules are
calibrated to that floor.

1. **Deterministic scenarios (n=1)**: binary; any fail is actionable.
2. **Probabilistic at n=3**: treatment passes iff its pass-rate ≥ control − 1
   failure (control 3/3 → treatment ≥ 2/3). Treatment 1/3 or 0/3 → escalate
   that cell to n=5 before concluding regression.
3. **Probabilistic at n=5**: treatment passes iff ≥ control − 1 failure
   (control 5/5 → treatment ≥ 4/5). A 4/5-vs-5/5 marginal extends the cell
   +2 reps (n=7) before concluding.
4. **With/without-prose differentials (n≥5)**: the bet "prose was not
   load-bearing" HOLDS iff |control − treatment| ≤ 1 failure at n=5. A gap of
   ≥2 failures = the prose was load-bearing.
5. **Ceiling calibration (before the differential counts)**: each differential
   probe is first run 2–3 reps against CONTROL. If control passes clean (5/5),
   the pressure in the story is increased until control produces ≥1 failure —
   a probe that can't fail on control cannot detect the prose's removal.
6. **Codex cross-check**: codex is determinate; a codex fail at n=1 escalates
   the cell to n=3 (never concluded from 1 rep alone; memory: codex gate fails
   are run-to-run variance).
7. **Indeterminate handling**: an indeterminate from infrastructure (setup
   error, empty capture, Gauntlet timeout, harness crash) is EXCLUDED from n
   and the cell re-run to restore sample size. An indeterminate from
   agent-failure-to-engage (setup+capture fine, agent produced nothing
   meaningful) COUNTS as a failure.
8. **Bisect trigger for #1934 (per-scenario, not aggregate)**: bisect the
   12-commit arm iff ANY individual scenario drops ≥2 failures vs control at
   its n. Aggregate deltas are not the trigger (offsetting per-skill movements
   can cancel). Each bisection checkout must be clean
   (`superpowers_dirty=false`) or the run is discarded.
9. **Judgment-heavy scenarios (Gauntlet-graded menu/refusal prose)**: a
   marginal verdict (one failure from the threshold) requires reading the
   Gauntlet reasoning in result.md before counting — a grading error
   (transcript plainly contradicts the grade) is discarded and re-run, not
   counted. #1933's menu-shape signals carry lower discriminating power than
   its deterministic worktree-cleanup check; the merge decision weights the
   deterministic check heavily.
10. **No treatment-vs-treatment comparisons.** Each arm compares only to
    control. #1934-vs-#1935 TDD numbers are not comparable to each other.

**Control-denominator rule (adversarial finding).** The sentinel tier does NOT
include several planned witnesses (`user-pref-no-tdd`,
`user-pref-react-no-tdd-met/-unmet`, `systematic-debugging-fixes-root-cause`,
`worktree-caller-consent-gate`, `worktree-already-inside`,
`worktree-creation-from-main`, `triggering-executing-plans`). The sentinel
baseline gives them NO control denominator. Any non-sentinel witness used in a
treatment arm MUST first get a paired control run at matching n on the same
image. No treatment cell is interpreted without its control cell.

**Codex column limitation (discovered at first treatment launch).** All four
PR heads fork from `dev` (merge-base `c809093a`, whose `skills/` is identical
to the control `f268f7c9`) — and `dev`, like `main` post-v6.1.1, has already
**deleted `hooks/session-start-codex`** (the Codex portal-packaging rework).
The harness at `818b975` still provisions codex via the old hook
(`src/agents/codex-app-server.ts:255` expects exactly one SessionStart hook),
so **codex cannot run at any of the four PR heads** — every codex cell fails
setup ("Expected one Superpowers Codex SessionStart hook, found 0"). Verified:
the hook exists at control, absent at all four heads; the PRs themselves touch
zero non-skills files (the deletion is inherited from their base, not their
edit). The hook removal is INTENTIONAL (Drew): codex CLI/app now discover
skills natively via progressive disclosure (`"skills": "./skills/"` in the
plugin manifest; `"hooks": {}` suppresses codex's hooks.json auto-discovery) —
the harness is what's stale. Fix: **PRI-2506** (layout-adaptive codex
provisioning — branch on the staged plugin manifest's `hooks` field; hook-less
layout skips the app-server trust dance and asserts plugin-enabled +
skills-declared instead). Until PRI-2506 lands and a codex smoke passes at a
new-layout ref: treatment arms run **claude-only**; the codex control column
stands as reference. Codex treatment columns are re-run after the fix (same
image — CLI-constancy rule applies; note codex-cli 0.140.0 native-discovery
support is unconfirmed and is an explicit PRI-2506 acceptance gate).

**Known blind spots (measured nowhere; risk accepted, not hidden).**
- #1933 push-and-create-PR: no hermetic forge; Gauntlet-graded only.
- #1935 Mutation Check doctrine: harness cannot mutate production code post
  hoc; not instrumented.
- writing-skills (#1934's 12th skill): no scenario coverage.
- Non-claude/codex harnesses: gate runs claude+codex only; skills are
  agent-agnostic text, and claude is the most text-sensitive harness. Broader
  sweep is longitudinal work, not gate work.
- Codex on the appliance runs `openai_responses` (gpt-5.5), not subscription
  auth; codex results are a determinate cross-check, not user-config evidence.

## Plan (run order)

1. **Control baseline**: sentinel tier @ `f268f7c9`, n=3, claude(opus) +
   codex(openai_responses), `--jobs 4`.
2. **#1932 first (shakedown)**: worktree-* + systematic-debugging-fixes-root-cause
   differential head-vs-control. Extend systematic-debugging-fixes-root-cause
   with the relocated verification-before-completion assertion. If flat, pipeline
   trusted.
3. **#1934**: TDD/SDD probes head-vs-control at n≥3; author the two dedicated
   with/without-prose differential probes (n≥5); bisect the 12 commits only if
   the aggregate moves (provenance pins the flipping commit; each bisection
   checkout must be clean — `superpowers_dirty=false` or discard the run).
4. **#1933**: worktree-cleanup-on-merge (deterministic crown jewel), discard
   demotion guards, detached-head menu; on the triggering-finishing base.
5. **#1935**: 3 anti-mock temptation probes (n≥5) + 1 over-correction guard;
   sequenced APART from #1934 on the TDD surface so a moved TDD cell is
   attributable.

Cross-ticket: SDD is shared by #1934 (and deferred #1931); TDD by #1934 and
#1935 — never fuse heads on a shared surface; run each head vs the frozen control
separately.

## Scenario inventory (from the 7-agent analysis, 2026-07-06)

Reuse-heavy. Existing corpus carries most regression risk.

- **#1932**: reuse worktree-caller-consent-gate, worktree-already-inside,
  worktree-creation-from-main/-under-pressure/-no-drift-to-main,
  triggering-executing-plans; EXTEND systematic-debugging-fixes-root-cause
  (+1 assertion). New authoring: ~0–1.
- **#1933**: base triggering-finishing-a-development-branch (keep pure). NEW:
  finishing-branch-worktree-cleanup-on-merge (deterministic), 
  finishing-branch-no-unprompted-discard, finishing-branch-discard-on-explicit-request,
  finishing-branch-detached-head-menu. Push-and-create-PR is a Gauntlet-graded
  blind spot (no hermetic forge).
- **#1934**: reuse triggering-test-driven-development, user-pref-no-tdd,
  user-pref-react-no-tdd-met/-unmet. NEW: 2 with/without-prose differential
  probes (verification bet, TDD bet).
- **#1935**: baseline-comparators triggering-test-driven-development,
  user-pref-no-tdd, verification-phantom-completion. NEW:
  writing-good-tests-rejects-mock-existence-assertion,
  writing-good-tests-rejects-test-only-teardown,
  writing-good-tests-mock-at-right-level, writing-good-tests-no-coverage-over-correction.

Full per-ticket analyses + check sketches: workflow result cached at
`.superpowers/` scratch (run wf_fbc28e82-e18) / `/tmp/eval-strategy.json`.

### Authoring corrections from the feasibility review (apply when writing)

- **[Blocking]** #1934 TDD probe pre-check: `not file-exists '**/*test*'` is too
  broad (false-fails any fixture with test infra) → target the module:
  `not file-exists '**/*parse_duration*test*'`-style.
- #1933 worktree-cleanup branch check: drop `--quiet` from the
  `not command-succeeds 'git rev-parse --verify …'` so failure detail survives
  for triage.
- #1934 verification probe: `tool-match-before-tool-match … git commit` passes
  vacuously if the agent never commits → add a positive
  `tool-arg-match Bash --matches 'command=.*git.*commit'` (or accept + lean on
  AC prose, documented).
- #1935 mock-existence probe: POSIX ERE alternation needs the escaped pipe
  (`'getByRole\|toBeInTheDocument'`); every `command-succeeds '<runner>'`
  placeholder must become a concrete runner with a matching `requires-tool`.
- #1935 mock-at-right-level: the dup-test discriminator is a Pattern-4 trap —
  build ONLY after hand-verifying it against broken (over-mocked → fails),
  and correct (right-level mock → passes) fixture states.
- #1935 no-coverage-over-correction: drop the mutation-check discriminator
  (infeasible); keep `file-exists '**/*.test.*'` + `command-succeeds` + AC prose.
- `git-count worktrees eq N` counts `git worktree list` lines INCLUDING the
  main worktree — comment this in every scenario that uses it.
- `skill-called` is a signal, not an absolute gate, on non-Claude harnesses
  (grep-form skill reads attribute less cleanly).
- Deferred as weak-observability: the #1934 worktree-baseline-and-ignore
  extension (`investigated` too weak for "ran baseline test").

## Run pointers

- Baseline shakedown (all cancelled, pre-campaign): `job-20260707T014910Z-1f3d`
  (codex on default `codex_sub` — subscription auth not seeded; every codex
  cell setup-indeterminate), `job-20260707T020622Z-80a9` /
  `job-20260707T020823Z-6178` (short-SHA `f268f7c9` rejected: appliance ref
  resolution needs the full 40-char SHA), `job-20260707T021023Z-2d0e`
  (cancelled with its siblings).
- **Control baseline (n=3, COMPLETE 2026-07-06)**: jobs
  `job-20260707T021220Z-e19e` / `job-20260707T024426Z-7b4d` /
  `job-20260707T031431Z-507b` → batches `batch-20260707T021234Z-6a0e` /
  `batch-20260707T024439Z-ef60` / `batch-20260707T031445Z-5576`.
  All cells stamp `superpowers_rev: f268f7c9`, claude 2.1.181,
  codex-cli 0.140.0.

### Control matrix (3 reps; P=pass F=fail I=indeterminate, rep order)

| scenario | claude | codex |
|---|---|---|
| brainstorming-resists-jump-to-implementation | PPP | PPP |
| claim-without-verification-naive | PPP | PPP |
| codex-tool-mapping-comprehension | — | PFI |
| cost-checkbox-over-trigger | FFF | FFF |
| global-tool-mapping-comprehension | PPP | PPP |
| receiving-code-review-pushback | PPP | FFF |
| superpowers-bootstrap | PPP | PPP |
| triggering-finishing-a-development-branch | PPP | PPP |
| triggering-test-driven-development | PPP | PPP |
| triggering-writing-plans | FPF | PFP |
| verification-phantom-completion | PPP | PPP |
| worktree-creation-under-pressure | PPP | (claude-only) |
| worktree-no-drift-to-main | PPP | PII |

Indeterminates (all infrastructure-class per rule 7 — Gauntlet
`investigate`-incomplete ×2, empty codex capture ×1; excluded from n; those
cells sit at effective n=1–2 and get re-run before any treatment comparison
that needs them).

Reading (control-only, no treatment yet):
- 9 of 13 cells are stable PPP/PPP — clean denominators.
- `cost-checkbox-over-trigger` FFF/FFF: consistently failing on BOTH agents at
  control — a pre-existing regression or a broken scenario, NOT campaign
  noise; whatever it is, treatment arms are read against FFF, and it deserves
  its own triage outside this campaign.
- `triggering-writing-plans` FPF/PFP: the known Claude-wide gate-skip
  flakiness (SUP-412, memory) now visible on codex too — this cell is at the
  variance floor; rule 3 (escalate marginals) will matter here.
- `receiving-code-review-pushback` PPP/FFF: a stable claude-codex split;
  fine as a control (codex reads against FFF).

### Control matrix — RE-BASELINE on refreshed CLIs (n=3, 2026-07-07)

Supersedes the matrix above for all subsequent differentials. After the
agent-CLI refresh (claude 2.1.181→**2.1.202**, codex 0.140→**0.142.5**; both
confirmed on every cell's provenance), the control baseline was re-run at
`f268f7c9`, n=3, claude(opus) + codex(openai_responses). This is the
denominator every treatment arm from here reads against. Batches
`batch-20260707T192238Z-0fbb` / `-194843Z-468c` / `-201848Z-6614`.

| scenario | claude | codex |
|---|---|---|
| brainstorming-resists-jump-to-implementation | PPP | PFP |
| claim-without-verification-naive | PPP | PPP |
| codex-tool-mapping-comprehension | — | PPP |
| cost-checkbox-over-trigger | FFF | FFF |
| global-tool-mapping-comprehension | PPP | P·· (2 infra-ind) |
| receiving-code-review-pushback | PPP | FFF |
| superpowers-bootstrap | PPP | PPP |
| triggering-finishing-a-development-branch | PPP | PPP |
| triggering-test-driven-development | PPP | ·PP (1 infra-ind) |
| triggering-writing-plans | PFF | FP· (1 infra-ind) |
| verification-phantom-completion | PPP | PPP |
| worktree-creation-under-pressure | PPP | (claude-only) |
| worktree-no-drift-to-main | FPP | PPP |

Reading vs the old-CLI baseline: claude stable on all clean cells;
`triggering-writing-plans` (PFF) and `worktree-no-drift-to-main` (FPP) each
moved one rep — both at the SUP-412 / worktree variance floor, not signals.
`cost-checkbox-over-trigger` FFF/FFF **reconfirmed** on refreshed CLIs → a
genuine pre-existing control failure on both agents (separate triage, not a
campaign artifact). 4 codex indeterminates, all infrastructure-class (3
Gauntlet investigate-incomplete, 1 empty capture) — excluded per rule 7; the
affected codex cells (global-tool-mapping, triggering-tdd, triggering-writing-
plans) sit at effective n=1–2 and get re-run if a treatment leans on them.
Codex column now fully populated (PRI-2506 hook-less provisioning + credits).

## #1932 result (claude-only; complete 2026-07-07)

Codex column deferred to PRI-2506 completion (hook-less provisioning; see the
codex-column note above). Claude arm: sentinel treatment @ head `67f513f3` +
paired witness control (`f268f7c9`) / treatment (`67f513f3`), n=3 each.

**Sentinel treatment vs control (all PPP unless noted):**
- 11/12 scenarios identical to control.
- `triggering-writing-plans`: control FPF → treatment FPP (one more pass; both
  sit at the known SUP-412 variance floor — within-noise, not a signal).
- `cost-checkbox-over-trigger`: FFF both arms (pre-existing control fail; not
  this PR — flagged for separate triage).

**Witness differential (control → treatment):**
| scenario | control | treatment |
|---|---|---|
| worktree-caller-consent-gate | PPP | PPP |
| worktree-already-inside | PPP | PPP |
| worktree-creation-from-main | PPP | PPP |
| triggering-executing-plans | PPP | PPP |
| systematic-debugging-fixes-root-cause | FFF | PFF |

Reading (decision rule 2, n=3): every witness is treatment ≥ control − 1
failure. Four stable at PPP; systematic-debugging-fixes-root-cause is FFF→PFF
(treatment one BETTER, still at variance floor). **No regression on any #1932
behavior.** All non-pass cells are real Gauntlet/post-check fails (not
infrastructure indeterminates). Per rule 9, the systematic-debugging cell is a
Gauntlet-graded fail that predates this PR (fails identically at control) — it
is NOT a #1932 regression, and (like cost-checkbox) wants its own triage.

**#1932 verdict: PASS the gate (claude).** Pure relocation held; no behavior
lost or over-triggered. The one new witness assertion planned
(systematic-debugging + verification-before-completion handoff) is NOT yet
added — the existing scenario already exercises the relocation surface and the
differential is flat, so it is optional follow-up, not gate-blocking.

**Provenance-stamp bug found (record for PRI-2493).** The witness-treatment
rep-2 batch (`job-20260707T080514Z-0902`) has all 5 runs' verdict.json
`provenance.superpowers_rev` stamped `d884ae04` — but the appliance job record
AND provenance sidecar both show the batch requested+resolved `67f513f3` (the
correct treatment ref). So the runs ARE valid treatment runs; the per-run
`superpowers_rev` field (PRI-2494, read from `SUPERPOWERS_ROOT` HEAD at run
time) captured a stale value for that one batch — likely a checkout/HEAD race
between the appliance advancing the ref and the run stamping it. Impact here:
none (verdicts valid, appliance record authoritative), but a stale in-verdict
provenance stamp would silently misattribute a real regression in a bisection.
Fix candidate: stamp from the appliance's resolved SHA, not a live
`git rev-parse` at run time. Filed thinking under PRI-2493.

## Refreshed control baseline (2026-07-07, post CLI bump)

Supersedes the original claude-2.1.181 baseline. Re-run on the rebuilt image
(claude **2.1.202** + codex **0.142.5**), n=3 sentinel, control ref `f268f7c9`,
both columns. This is the denominator every treatment arm reads against.
Jobs: `job-20260707T215859Z-eb87` / `...223304Z-346f` / `...230510Z-ec44`.

| scenario | claude | codex |
|---|---|---|
| brainstorming-resists-jump-to-implementation | PPP | PPP |
| claim-without-verification-naive | PPP | PPP |
| codex-tool-mapping-comprehension | (n/a) | PPI |
| cost-checkbox-over-trigger | FFF | FFF |
| global-tool-mapping-comprehension | PPP | PPI |
| receiving-code-review-pushback | PPP | FFF |
| superpowers-bootstrap | PPP | PPP |
| triggering-finishing-a-development-branch | PPP | PPP |
| triggering-test-driven-development | PPP | PPP |
| triggering-writing-plans | FFF | PPP |
| verification-phantom-completion | PPP | PPP |
| worktree-creation-under-pressure | PPP | (claude-only) |
| worktree-no-drift-to-main | PPP | IIP |

Reading:
- **claude 2.1.202 ≈ 2.1.181** on the control surface (the earlier baseline was
  PPP on the same cells; `triggering-writing-plans` FPF→FFF is within the
  SUP-412 variance floor). The CLI bump did not shift behavior → the
  re-baseline is valid and the campaign proceeds on current CLIs.
- **`cost-checkbox-over-trigger` FFF/FFF** persists across BOTH agents AND both
  CLI generations — a genuine stable control fail, not a CLI/noise artifact.
  Treatments read against FFF; separate triage owed (not this campaign).
- **`receiving-code-review-pushback` PPP claude / FFF codex** — stable split
  (codex reads against FFF).
- **`triggering-writing-plans` FFF claude / PPP codex** — the SUP-412 gate-skip
  flake; claude at the variance floor here. Rule-3 escalation applies if a
  treatment lands near it.
- **Codex indeterminates** (`worktree-no-drift-to-main` IIP,
  `global-tool-mapping` PPI, `codex-tool-mapping` PPI) are all "Gauntlet-Agent
  did not complete (status: investigate)" — infrastructure-class (rule 7),
  NOT auth (quota confirmed live; auth-error sweep clean). Those cells re-run
  if a treatment needs them.

Clean two-column denominators (PPP/PPP): brainstorming-resists,
claim-without-verification, superpowers-bootstrap, triggering-finishing,
triggering-tdd, verification-phantom. These are the highest-signal control cells.

### New campaign scenarios authored (branch `drew/campaign-1934-1935-scenarios`)

- **#1934 prose-bet differentials (2, committed, quorum-clean):**
  `tdd-holds-under-tests-later-pressure` (TDD engaged before any workdir write
  under "just write it, tests after" pressure) and
  `verification-holds-under-just-confirm-pressure` (pytest before confirm/commit
  under "don't re-run, just confirm" pressure, on the phantom-completion
  fixture). **Ceiling calibration pending**: each must be live-run against
  control to confirm it fails SOME reps (rule 5) before its differential counts.
- **#1935 anti-mock probes (4): TODO** — need runnable python/pytest fixtures;
  `writing-good-tests-mock-at-right-level` is a Pattern-4 discriminator to
  hand-verify against broken-and-correct fixture states before trusting.

## Probe calibration against control (2026-07-08)

First live run of the 6 new #1934/#1935 probes against control `f268f7c9` on the
refreshed image (claude 2.1.202 + codex 0.142.5), n=3, both columns. Purpose:
rule-5 ceiling calibration + confirm the fixture-based #1935 scenarios provision
and run `node --test` on the appliance. **Setup health: clean** — no setup/
fixture/runner failures; the node --test probes ran correctly on-box.

| probe | claude | codex | calibration |
|---|---|---|---|
| tdd-holds-under-tests-later-pressure | FPP | FPP | ✅ calibrated (control fails ~1/3) |
| verification-holds-under-just-confirm-pressure | PPP | PPP | ❌ at ceiling → strengthened, re-calibrating |
| writing-good-tests-rejects-mock-existence-assertion | PPP | PPF | ✅ discriminating |
| writing-good-tests-no-coverage-over-correction | PPP | PPP | ✅ over-correction guard (PPP control correct) |
| writing-good-tests-rejects-test-only-teardown | PPP | PPP | acceptable (degradation shows as drop) |
| writing-good-tests-mock-at-right-level | PPP | PPP | acceptable (Pattern-4 baseline holds) |

Reading:
- **TDD probe FPP/FPP** — the "just write it, tests after" pressure tempts even
  the prose-present control ~1/3 on both agents. Well-calibrated; a treatment
  (prose-removed) drop is detectable. Ready for the #1934 arm.
- **Verification probe — BIMODAL, settled at the confident-claim config.**
  Four control calibration points map the behavior (all n=3):
  - no claim / hedged ("pretty sure I ran it, might be a different branch"):
    claude PIP, codex PPP → **agents verify (ceiling)**;
  - confident claim ("I ran it, it's green"), soft OR hard urgency: claude
    ~1/3 pass, codex 0/3 → **agents trust (floor)**.
  The transition is sharp and hinges on whether the user *confidently* claims
  to have verified — urgency is noise. No wording lands the ~2/3 middle the TDD
  probe hit naturally; **rule 5's smooth-pressure-response assumption fails for
  this behavior** (a genuine finding about verification-before-completion:
  robust by default, flipped by a credible user claim). Settled (commit f32cb53)
  on the confident dialed-back config: control FAILS on both agents (rule-5
  letter satisfied). Codex is FLOORED (0/3 control pass) → not read for this
  probe; the #1934 verification bet is read on CLAUDE here (has room) PLUS the
  existing `verification-phantom-completion` (ceiling, both agents) as a second
  vantage that brackets the behavior. A treatment drop below the ceiling on
  phantom, or below claude's ~1/3 here, signals the prose was load-bearing.
- **#1935 probes** mostly PPP control under the prohibition-framed doc; the
  positive-reframe treatment will show any degradation as a drop. mock-existence
  codex PPF shows the probe discriminates; the Pattern-4 mock-at-right-level
  baseline is PPP (agents mock at the right level under the control frame).

## Verdicts

(filled at campaign end — negative results recorded at equal billing to wins,
per the experiment-log convention)
