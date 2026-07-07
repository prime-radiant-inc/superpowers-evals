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
- **Control baseline rep 1**: `job-20260707T021220Z-e19e` @ control
  `f268f7c9…`, claude(opus)+codex(openai_responses), sentinel, `--jobs 4`.
  Early cells verify provenance: `superpowers_rev: f268f7c9`, claude 2.1.181,
  codex-cli 0.140.0. Reps 2–3 chained serially behind it (local watcher).

## Verdicts

(filled at campaign end — negative results recorded at equal billing to wins,
per the experiment-log convention)
