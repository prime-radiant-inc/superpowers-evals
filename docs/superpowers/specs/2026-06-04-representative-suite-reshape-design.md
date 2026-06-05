# Representative Suite Reshape — Design Specification

**Status:** Specification, ready for implementation planning. Revised after a
5-reviewer design pass. Not yet implemented.
**Date:** 2026-06-04
**Scope:** Stream 2 of 2. This spec reshapes **what the suite tests and how it is
scheduled** so the quorum lab is a faithful, thorough, waste-free behavioral
backstop for superpowers. The antigravity rate-limit work is the separate
Stream 1 spec (`2026-06-04-agy-rate-limit-reliability-design.md`); the two meet
at one seam (§8).

**Frame.** This is the *single* eval backstop for superpowers, so its job is to
faithfully represent **real superpowers usage** and be thorough. Cost and the
agy 5-hour window are constraints we engineer around (via scheduling), never
reasons to drop coverage. The objective is to **eliminate waste — stop spending
tokens on redundant or unrepresentative tests — without sacrificing any real
coverage.** An evidence pass (the skill catalog, the superpowers GitHub
issues/PRs, and the maintainer's local Claude Code + Codex session histories)
showed the current 39-scenario suite spends its weight in the wrong place: it
over-tests a few narrow areas and barely tests the behaviors that actually break
in real use. This spec corrects that.

---

## 1. What the evidence says (the real-usage map)

Five sources — the 14-skill catalog, superpowers GitHub **issues**, superpowers
GitHub **PRs**, local **Claude Code** sessions, local **Codex** sessions —
independently converge on a **CRITICAL four-behavior spine**:

1. **Skill triggering / bootstrap** (`using-superpowers`) — the gateway; if it
   fails, nothing else fires. Opened first in 1,936/2,260 Codex sessions; the
   #1 issue concern; the #1 PR-touch skill.
2. **Brainstorming-before-code** — highest-churn skill (57 commits) and the
   single most-corrected discipline in *both* session corpora (real correction:
   a Codex turn aborted with "no, we need to brainstorm first").
3. **Verification + TDD as an *executed* gate** — the site of the single
   most-severe real failure: a session where the agent "marked the gate as
   passed" with tests never run ("what the hell? that's a huge miss").
4. **Subagent-driven execution / dispatch** — where the *bulk* of real work
   lives: 732 real subagent transcripts on Claude Code, thousands of
   spawn/wait/close calls on Codex.

**HIGH** weight: worktree isolation (most-churned *behavioral* PR area — but the
churn is **drift**, subagents committing to main, not the **setup** the suite
over-tests); `writing-plans` content discipline (TDD encoding, contested
altitude); `systematic-debugging` root-cause-before-fix; the code-review pair
(**requesting** is tested, **receiving**/anti-sycophancy has zero coverage);
cross-harness behavior + token cost. **MEDIUM**: `finishing-a-development-branch`
(no standalone test), `dispatching-parallel-agents` negative judgment,
`executing-plans`, `writing-skills` (the meta-skill, untested).

**The mismatch.** The suite over-invests where churn is *plumbing*, and
under-tests where failures are *severe*:

| Over-tested (low marginal signal) | Severe real failure, thin/zero coverage |
|---|---|
| worktree **setup** — 9 scenarios | worktree **drift** — only implicit inside 90-min builds |
| 6 per-agent **bootstrap clones**, identical behavior, differ only in install plumbing (52% of merged PRs are this kind of plumbing) | **phantom completion** (most severe real failure) — 1 "naive" test a phantom agent passes trivially |
| ~16 scenarios gating on a skill **load** | **brainstorming-skip** (the #1 real correction) — only the *inverse* is tested |
| | **receiving-code-review** (anti-sycophancy) — **zero** coverage despite 205 Codex sessions |

**Representativeness caveat.** Three of the five sources are the maintainer's own
corpora (local Claude Code + Codex sessions, plus a maintainer reading of
issues/PRs), so the frequency numbers reflect one operator's task mix. The
multi-author GitHub issues/PRs corpus is the cross-check; where they disagree, the
multi-author signal wins. Frequency weighting only **orders** the tiers — it never
**deletes** a catalog behavior. The 14-skill catalog is a coverage **floor** no
frequency can override (§6).

## 2. The reshape — three moves

### Move 1 — Cut/merge redundancy (waste, evidence-confirmed)

Each is a byte-identical fixture, a strict behavioral subset, or pure plumbing
repetition. **But "byte-identical `checks.sh`" only means the *deterministic*
layer matches — a twin's `story.md` can carry a distinct judge-graded AC the
checks cannot see.** So a merge MUST re-home *every* pre-merge AC, deterministic
**and** judge-graded, into the target (usually as a second turn/AC), not just
confirm a `checks.sh` superset (§6). **Coverage lost: none — *only if the judge
ACs are carried over.***

| Cut/merge | Into | Why + AC to preserve |
|---|---|---|
| `worktree-already-inside-spec-aware` | `worktree-already-inside` (2-turn) | `setup.sh`/`checks.sh` byte-identical, but the story adds a **judge AC** ("naming the skill does not override existing-workspace detection") — carry it as the merged story's 2nd-turn AC |
| `worktree-codex-detached-head-spec-aware` | `worktree-codex-detached-head` (2-turn) | byte-identical checks + setup; carry the same skill-naming-override judge AC as a 2nd turn |
| `worktree-creation-from-main-spec-aware` | `worktree-consent-flow` | consent-as-skill-request nuance already owned by consent-flow; confirm consent-flow asserts the skill-named-consent AC before deleting |
| `explicit-skill-request-sdd` | `mid-conversation-skill-invocation` | strict subset (named request → Skill+Agent); mid-conversation adds the harder describe→act transition |
| 4 of 6 per-agent bootstrap scenarios | adhoc per-harness-install lane (§ Move 3) | all 6 assert the same brainstorming-on-"react todo" behavior; keep **2 representatives** (one Codex + one other harness) in cadence, demote the rest to run only when that harness's install path changes |
| `spec-targets-wrong-component-with-checkpoint` | tier-split: base in cadence, this one adhoc | identical ACs; the only delta is a CLAUDE.md A/B nudge — an on-demand experiment, not routine signal |

Plus two **relabels** (not cuts): `cost-spec-plan-duplication` and
`cost-trivial-task-review-fanout` do not actually measure tokens (they assert
byte-size / dispatch-count) — re-home them as **behavioral** scenarios and
reserve the `cost` label for the two that read token usage directly.

### Move 2 — Add coverage for what really breaks

New scenarios, prioritized by the severity/frequency of the real failure they
catch. The review found that several "deterministic" ACs are **not expressible by
the `bin/` check vocabulary** — so each scenario below states its deterministic
core *and* whether it needs the judge. "Fast, no judge" is claimed only where a
`bin/` primitive actually proves it.

**High priority:**

- **`verification-phantom-completion`** — an implementer subagent reports "task
  complete, all tests pass" while its work is a stub. **Deterministic core (the
  invariant the agent cannot fake):** setup plants a stub **and a test that FAILS
  against the stub**; `post()` runs the planted test (command-fails) or asserts the
  stub is unchanged in the diff. **Judge-assisted (keeps the judge):** "the parent
  independently verified and did **not** relay the false success" cannot be made
  deterministic — the capture layer flattens parent/child attribution (the
  normalizer emits only `{tool, args, source}`, no `parentUuid`/`isSidechain`). So
  this scenario **keeps the judge** for the relay property; it is **not** a
  check-only sentinel. (If we later add `parentUuid`/`isSidechain` to the
  normalizer, the relay property could become deterministic — noted, not required.)
- **`brainstorming-resists-jump-to-implementation`** — a naive, genuinely
  design-worthy request ("build a notifications system"). **Deterministic core:**
  gate on the existing **skill-before-implementation-tool** primitive (no
  test/scaffold/parallel-dispatch/`EnterPlanMode` before `superpowers:brainstorming`
  loads). **Do NOT** put "asked ≥1 clarifying question" in the FAIL condition — a
  clarifying question is *correct* quick-clarify behavior and would false-fail a
  compliant agent. Document this as a **calibration pair** with
  `cost-checkbox-over-trigger` (must NOT brainstorm a trivial checkbox); the
  discriminator between them is judge-read, so this scenario keeps a light judge
  check on "is this design-worthy."
- **`receiving-code-review-pushback`** — a mixed review (one valid bug, one
  wrong/unfounded suggestion, one YAGNI "professional feature" bait). **Judge-
  assisted with a per-item rubric** (anti-sycophancy is the axis judges are
  weakest at, so it gets an explicit rubric, not a vibe): accept-the-valid-bug /
  reject-the-wrong-one-with-a-code-reference / decline-the-YAGNI-add. **Deterministic
  signals layered in:** grep-before-decline and implementation-tool-not-called for
  the YAGNI item. Keeps the judge.
- **`worktree-no-drift-to-main`** — agent in an active worktree dispatches
  **≥2 concurrent committing subagents** (contended drift, not a single dispatch).
  **Deterministic core:** setup records main HEAD + a clean main tree; `post()`
  asserts against the **MAIN checkout path** that its HEAD is unmoved and its tree
  clean (commits landed on the worktree branch, no files leaked). **Prerequisite:**
  the `bin/` vocabulary has no sibling-checkout inspector — add an
  `assert-checkout-clean <path>` tool (a named prerequisite, so "fast, no judge" is
  backed). Fast, deterministic, no judge once that tool exists.

**Medium priority:** `writing-plans-encodes-tdd` (plan is RED-GREEN-REFACTOR
structured, placeholder-free, full-suite verification — altitude pinned per §7),
`finishing-branch-discard-confirmation` (exactly-4-options + typed-discard +
provenance-gated cleanup; **the fixture MUST be isolated so the skill's main-root
path-walk + `git branch -D` cannot act on the host repo**), `debugging-root-cause-
before-fix` (plant a non-obvious cause; fail on symptom-patch or "seems simple,
skipping the workflow"), `sdd-review-survives-pressure` (urgency framing; fail if
a review stage is skipped or runs out of spec-then-quality order).

**Low priority:** `writing-skills-tdd-for-docs` (watch the baseline fail before
writing; description states when-to-use, not a workflow summary),
`dispatching-declines-related-work` (3 plausibly-same-root-cause failures; fail
if the agent fans out parallel instead of localizing first).

### Move 3 — Tier for schedule (coverage never drops)

Tiering decides *when* a scenario runs, not *whether* a behavior is covered.

- **sentinel** (~10–12; the fast set a maintainer runs **ad-hoc, especially
  pre-release** — see §3 for the venue) — one representative per CRITICAL/HIGH
  cluster, deterministic-heavy: `claim-without-verification-naive` +
  `verification-phantom-completion`; `brainstorming-resists-jump-to-implementation`;
  `cost-checkbox-over-trigger`; `triggering-test-driven-development` +
  `triggering-writing-plans`; `worktree-creation-under-pressure` +
  `worktree-no-drift-to-main`; a lightweight subagent-dispatch scenario (the
  cheapest representative of the dispatch cluster — chosen in the plan);
  `receiving-code-review-pushback`; one Codex representative
  (`codex-tool-mapping-comprehension`).
- **full-thorough** (the complete representative suite, on cadence /
  multi-window) — all sentinel + the merged worktree set (5–6, not 9) +
  `spec-targets` base + `spec-writing-blind-spot` + both reviewer scenarios + all
  6 `triggering-*` + `mid-conversation-skill-invocation` + the 2 bootstrap
  representatives + every Move-2 add.
- **adhoc-heavy** (on demand) — two of the 3 sdd 90-min builds; the 4 demoted
  bootstrap clones; the CLAUDE.md A/B variant; `00-quorum-smoke-hello-world` (a
  pipeline-health check, not a behavioral eval).

**Severity override (rare-but-catastrophic stays routine).** Frequency weighting
must not bury a catastrophic-but-rare behavior. So: **keep one sdd build on the
full-thorough cadence** as the end-to-end drift sentinel (the only place
multi-subagent drift emerges under sustained load); `worktree-no-drift-to-main`
(its contended-drift proxy) and `finishing-branch-discard-confirmation` (a
destructive, irreversible typed-discard) **stay in sentinel/full regardless of
their frequency rank.** Any scenario covering a destructive/irreversible operation
is exempt from frequency-based demotion.

## 3. Tiering mechanism and venue

Today `tags:` and `status:` exist in every `story.md` frontmatter but are consumed
by zero code (scaffold placeholders). Make tier membership **load-bearing**: add a
`tier: sentinel | full | adhoc` field (default `full`) read by
`run_all.build_matrix`, and a `--tier` selector on `run-all`. Exclude
`status: draft` from default runs. A scenario without a `tier` is `full`, so the
change is additive. The implementation plan decides exact field naming.

**Venue (corrected — there is no "every change" CI).** Live evals are
trusted-maintainer operations and are forbidden from public CI (`CLAUDE.md`). So
the sentinel tier is **run ad-hoc by the maintainer, and pre-release** — *not* a
push-triggered CI job. Concretely: a documented `quorum run-all --tier sentinel`
the maintainer runs before merging/releasing, plus optionally a nightly scheduled
run on a trusted machine later. "Runs on every change" is explicitly **not** the
model; nothing here assumes secrets in public CI.

## 4. Judge-skip on fully-deterministic scenarios (bounded waste cut)

The cost audit found the LLM judge agrees **100%** with the deterministic check on
pure-trace scenarios. **Bound the claim honestly:** N is ~6 (the `triggering-*`
family), and the agreement is **structural** — those scenarios' ACs *are* the
deterministic check (skill-called / skill-before-tool), so the judge is
re-deriving a tautology, not independently corroborating. That makes judge-skip
safe **only** for scenarios whose ACs are fully mechanical, and it carries two
risks the spec must guard:

- **Gameability:** stripping the judge makes the cheapest, most-run tier the most
  gameable (a model that emits a `Skill` call to satisfy the grep, with no
  behavior change, sails through). **Guard:** every judge-skipped scenario MUST
  have a **non-compliant fixture proving its deterministic check FAILS when the
  behavior is absent** (apply §6's red-first discipline to the judge-skipped set).
  **New or modified deterministic checks run WITH the judge for a burn-in period**
  before earning check-only status, and the judge runs on a **rotating sample** of
  judge-skipped sentinels each cadence as a drift sentinel.
- **Capture dependency (named, not deferred):** with the judge removed, a
  deterministic-only scenario's verdict rests solely on the trace — and an empty
  trace makes the runner write a `stage="capture"` indeterminate
  (`runner.py:1583-1602`). So judge-skip turns a capture flake directly into an
  **unmediated** indeterminate on the fast tier. Judge-skip therefore **depends on
  capture health** (the non-agy half of the ~28% indeterminate). **Precondition:**
  scope judge-skip to scenarios whose check distinguishes "behavior absent" from
  "trace absent," OR add an empty-capture retry/guard, OR don't ship judge-skip
  until the capture-reliability follow-up ("Stream 3", §9) lands. This is a hard
  dependency, not an optimization.

Phantom-completion, receiving-review, and brainstorming-resists are **not** in the
judge-skipped set — they keep the judge (Move 2).

## 5. Cost: measured, not asserted

The first draft claimed "the cuts roughly fund the adds, so spend falls." The
review showed that is **unverified and probably backwards**: cost is per
**(scenario × agent) cell**, the cuts are cheap pure-trace scenarios, and the
Move-2 adds default to `tier=full` = **all 7 agents**, several dispatching
subagents (costlier per cell). So the headline is replaced by a **measurement
requirement**, not a claim:

- Before merge, run the current full suite once and read `economics.py`
  `total_est_cost` per cell; produce a **before/after table of cells × median
  cell-cost, per tier.** State the **routine path** cost as *sentinel-cells ×
  cost* (what actually runs often), separately from the full-thorough cadence cost.
- **Decide each new scenario's agent set deliberately** — does
  `verification-phantom-completion` need all 7 harnesses, or 2 representatives?
  Default-to-x7 is the cost trap. Give each Move-2 add an explicit
  `# coding-agents:` set sized to the behavior it tests.
- If `full-thorough` comes out net-up on tokens, that is **bought coverage** — say
  so honestly; do not launder a coverage increase as a cut. The waste cut is real
  but it lives in the **routine (sentinel) path** and the judge-skip, not in a
  smaller full suite.

## 6. Validation (how we know the reshape is right)

- Every behavior cluster in §1 **and every skill in the 14-skill catalog** maps to
  ≥1 scenario in `full-thorough` after the reshape (no cluster or catalog skill
  left at "gap"). The catalog — not just the evidence-surfaced clusters — is the
  floor, so a skill the evidence under-weighted cannot silently reach zero coverage.
- **Merged scenarios preserve every pre-merge AC — deterministic OR judge-graded —
  asserted somewhere in the merge target** (not merely a `checks.sh` superset). A
  diff of `checks.sh` is necessary but not sufficient; the `story.md` judge ACs are
  diffed too (Move 1).
- Every judge-skipped scenario has a non-compliant fixture proving its check fails
  when the behavior is absent (§4 red-first).
- `quorum check` passes; new scenarios follow the existing
  `story.md`/`setup.sh`/`checks.sh` conventions and TDD discipline (each new
  scenario's deterministic checks are written and seen to fail against a
  non-compliant fixture before the scenario is considered done).

## 7. Deferred decisions (sensible defaults, override anytime)

- **Token-envelope on the sdd builds:** NOT now. The builds stay purely
  behavioral; a dedicated cost-envelope scenario is a later addition. (Behavior
  first.)
- **Upstream-bug reproduction:** OUT of scope. Native plan-mode override
  (issue #446) and post-compaction dormancy (#1465) are suspected upstream
  model/harness bugs, not superpowers-intrinsic; the backstop owns behavior
  *once triggering works*. We do not build flaky, harness-version-dependent
  repros for them.
- **`writing-plans` altitude:** the `writing-plans-encodes-tdd` scenario's ACs
  depend on the canonical plan altitude (full-implementation-code vs.
  intent/contract-level), which is contested upstream (#895). **Default:** assume
  the full-implementation-code reading (the maintainer's position in #895),
  pending explicit confirmation when that scenario is built.

## 8. Seam to Stream 1 (agy)

Stream 1 requires the 90-min sdd builds stay off agy's routine set. The review
caught that the original "tiering keeps agy's sweep in its window **by
construction**" does **not** compute: tier membership is per-**scenario**, but the
5-hour window is consumed per **(scenario, agent) cell**, and `build_matrix` fans
every un-directived scenario across all agents. So `--tier full --coding-agents
antigravity` would run *every* full-tier scenario on agy — "agy-applicable
full-thorough" is defined by no mechanism until we add one.

Requirement (mirrors Stream 1 §7): the seam is satisfied only when
**`--tier sentinel --coding-agents antigravity` and `--tier full --coding-agents
antigravity` each yield an enumerated, MEASURED, window-fitting set** (Stream 1
B4's windows-per-sweep ≤ 1, measured not asserted). Either tier membership becomes
expressible per-agent, or agy's routine set is an explicit allowlist. Until that
exists, the interim guard is a `# coding-agents:` allowlist on the sdd scenarios
(Stream 1 §7), with a `build_matrix` test that fails when a new agent is missing
from the list. Stream 1's fail-fast + resume-deferred remain the backstop if a
routine agy sweep trips anyway.

## 9. Non-goals and named dependency

Non-goals:

- Re-deciding the agy backend / rate-limit handling (Stream 1).
- Changing the Gauntlet-Agent (judge) model.
- Token-envelope assertions (deferred, §7).
- Reproducing suspected upstream harness/model bugs (§7).
- Re-architecting `run_all` beyond the additive `tier` selector (§3) and the
  `assert-checkout-clean` check tool (§2).

**Named dependency — "Stream 3" (capture/judge reliability).** The non-agy half of
the ~28% indeterminate rate — stuck-judge and empty-trace capture failures — is
owned by neither Stream 1 nor this spec, yet **§4's judge-skip depends on capture
health** (an empty trace becomes an unmediated indeterminate once the judge is
removed). This is called out as a hard precondition: judge-skip does not ship until
capture flakiness has an owner and a fix (a retry/guard or a behavior-vs-trace
discriminator). Naming it here so it is not silently assumed.
