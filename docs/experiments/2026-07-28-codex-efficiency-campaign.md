# Codex efficiency eval campaign — closeout

**Campaign:** `campaigns/codex-efficiency/` (plan:
`docs/plans/2026-07-28-codex-efficiency-evals.md`, Task 13)
**Hypothesis log (append-only, the primary record):**
`logs/2026-07-28-codex-efficiency.md`
**Source audit under test:**
`superpowers/docs/superpowers/research/2026-07-28-codex-efficiency-audit.md`
**Dates:** 2026-07-28 → 2026-07-30
**Spend:** ≈$153.2 (of which $152.34 instrumented) against a $1000 budget

## 1. Executive summary

The audit described eight efficiency pathologies in Codex multi-agent
sessions. This campaign built ten experiments and ten scorers to test them
against evidence rather than narrative, and the headline is a split
verdict: **most of the audit's fresh-session pathologies do not reproduce
on current `dev` at the field Codex CLI, and the ones that do reproduce
are structural — properties of the harness and the workflow shape, not of
agent discipline.**

Four things are worth carrying forward.

**The strongest finding is recursion shape.** Every depth-2 spawn observed
anywhere in this campaign — 9 occurrences across 4 independent
corpora/sources, including one real desktop session and one external
client corpus — was issued by an *implementer*, spawning a *reviewer*,
alongside a separate controller-initiated review of the same task. Zero
counter-examples: no reviewer ever spawned a depth-2 child, in any corpus
scored. All 9 also match the stricter same-task-duplicate-review pattern.
This is the campaign's most-reproduced result and the clearest treatment
target.

**Most fresh-session pathology was a version artifact.** E1's baseline
fork-hygiene failure vanished at Codex CLI 0.146 (the field version): dev
shows 14/14 isolated, explicit-model root spawns, and the same clean
result reproduces on superpowers `v6.1.1` (22/22), which eliminates
skill-version dependence as an explanation. What is left of the pathology
lives one level down, in child-initiated spawns.

**Two pathologies are structural, not behavioral.** Wait-polling waste
reproduces everywhere (60–80% of `wait_agent` calls time out, across three
independent corpora including a fresh 3-task battery) because the default
poll timeout is shorter than a real unit of subagent work — a cadence
mismatch, not session-scale pathology. And `close_agent` non-closure is a
schema fact: the tool exists only in multi-agent V1, so V2 controllers
score 0/N by construction, and the "always close your children"
recommendation is unexecutable on V2 rather than ignored.

**Lifecycle honesty held up in fresh sessions and failed in the long one.**
All three engineered truthfulness probes produced *honest* records
(missing predictions in the honest direction), and citation integrity was
100% across a 38-run fresh corpus — while the one real long session in the
evidence base fabricated 2 of its own evidence citations. The pathology
appears to be a property of long, loaded sessions, and the specific
mechanisms the audit's worst examples describe (soft per-agent budget
exhaustion) are unreachable from outside the harness.

Six of ten experiments landed inconclusive-by-zero on at least one
registered clause. That is reported as a result, not a failure: the
discrimination rule this campaign ran under treats "the rig never produced
the phenomenon" as a stop, and stopping cheaply is what kept a
ten-experiment campaign at 15% of budget.

## 2. Per-experiment results

Every prediction below was registered in the hypothesis log **before** the
battery ran (and before the scorer existed, for the MINE-tier ones).
"Inconclusive-by-zero" means the rig never produced a single instance of
the measured phenomenon, so the prediction can be neither confirmed nor
refuted — a stop under the campaign's discrimination rule.

| # | Registered prediction | Verdict | Key numbers |
|---|---|---|---|
| **E1** — fork hygiene | Baseline: ≥40% of SDD spawns use `fork_turns:"all"`, ≥60% omit `model`. Treatment (spinout): 100% isolated, 100% explicit, completion preserved. | **Split, then terminal.** Axis B (isolation) inconclusive-by-zero on fresh sessions → re-scoped into E6. Axis A (model) discriminated at container CLI 0.144.4, then stopped discriminating at field CLI 0.146. | Baseline @0.144.4: **34/34 isolated** (prediction miss), **0/34 explicit** (prediction hit). @0.146: dev **14/14** isolated + explicit; spinout root **31/31** explicit (33 raw spawns, 2 omissions both depth-2 child-issued). Treatment's literal 100% bar unmet only because the container CLI predated 0.145's model param. |
| **E1-v611** (Amendment 2) | Either v6.1.1 reproduces the pathology (skill-version-dependent, fixed by v6.2.0) or it is clean (long-history theory strengthens). Bet registered on clean. | **Clean — bet lands.** Skill-version dependence eliminated. | **22/22** root spawns isolated + explicit at v6.1.1/CLI 0.146. The one non-clean spawn of 23 is depth-2, child-initiated — the same shape seen twice on spinout. |
| **E2** — reviewer recursion | A dispatched branch reviewer produces ≥1 descendant in ≥half of reps. | **Inconclusive-by-zero (terminal).** Folded into E6, as pre-registered. | MICRO: **0/20** spawns of any kind across 4 phrasing variants, **20/20** seeded bug found. FULL: **4/4** reps dispatch exactly one reviewer, **0** non-root spawns. Live probe confirmed collaboration tools *were* available — a real elicitation finding, not a tool-availability artifact. |
| **E3** — duplicate gates / receipts | The full suite runs ≥2× at an identical tree state across implementer→review→finishing. | **Inconclusive on fresh finishing flows; confirmed in SDD loops.** Duplication lives in the SDD loop, not the finishing gate. | Fresh `cx-finishing`: **0/3** duplicate gates (the reruns present were merge-justified). Waiver probe: **0/2** violations — waivers respected, re-verification correctly scoped. MINE re-score: **1/23** runs show a true duplicate pair (corrected down from 5/23 by a real de-escape bug fix). 07-29 corpus: the 9× identical-regression cluster validated (the audit said 12×). Invalidation probe **PASSES** on dev — a regression baseline for the receipts treatment. |
| **E4** — proportional ceremony | Ceremony census is statistically indistinguishable across spike / bounded / architectural task classes. | **Inconclusive-by-zero on the primary gate for a structural reason; partial pathology where measurable; the MICRO found the lever.** | Spike **3/3** reps never produce a tracked-file patch, so "ceremony before first code" has no anchor — the gate is uncomputable, not flat. Bounded vs arch: ceremony scales *somewhat* with complexity, but the planning ritual is invariant — **2 docs before code in every rep**, design-then-plan. MICRO (45 API calls): the **current verbatim hard-gate text pushes the bounded task to FULL ceremony 5/5**, while Z-null and a drafted three-path router both differentiate perfectly and identically (spike→SPIKE, bounded→BOUNDED, arch→FULL, 5/5 every cell). **The literal gate text is the lever.** |
| **E5** — review scope / accretion | The local-scope defect is caught; ≥1 of {cross-task race, clean-checkout break, repair-induced regression} is missed by mismatched scope or duplicated across same-scope reviewers. | **Recall clause confirmed; scope-blindness inconclusive-by-zero by design tradeoff; two Amendment-3 measures landed.** | Crisp seeds caught **3/3** reps. Serial remediation (Amendment 3) **2/3 reps, (0,1,2) cycles** — confirmed. Same-scope duplicate reviews **0/3**. Criterion-less gate findings **0/13** first-pass Critical/Important findings — the withdrawn-restore archetype does not appear in a fresh battery. Accretion: scripted-fix commits only, no unadjudicated new scope. Known limitation: the D4 scope classifier does not parse compound shell commands (flagged, not silently patched). |
| **E6** — compaction recovery | After forced compaction the controller re-reads ≥1 already-read SKILL.md **and** ≥1 post-compaction spawn drops isolation or model explicitness. | **Split verdict.** Clause (a) fails on dev, corroborated elsewhere; clause (b) holds narrowly; the depth-2 sub-finding is the campaign's strongest. | Mechanism: `model_auto_compact_token_limit=40000`, source-verified, **6/6 reps ≥1 real compaction**. (a) re-reads: dev **0/3**, spinout **1/3** (recovery hook firing live), external stress corpus **1** organic re-read with no hook. (b) hygiene: dev **20/21** post-compaction spawns explicit (one root-controller omission, immediately post-compaction), spinout **21/21**; **isolation never degrades on either arm**. The broken streak is **14/14 on dev alone** (45/45 combined across both E1 CLI-0.146 arms) — thin, n=1, correctly directional. (c) **9 depth-2-by-implementer occurrences across 4 corpora, all 9 also same-task duplicate reviews, 0 counter-examples.** (d) forced compaction adds 2–3 events and ~15–25% root lines without derailing completion (**6/6** pass). |
| **E7** — wait-polling waste (MINE) | 78% of the stress run's ~805 polls time out; 74% (788/1058) on the audit's high-wait root; our own short battery runs show *materially* lower rates. | **2 of 3 clauses confirmed; the third fails. Waste is STRUCTURAL.** | Stress run: **805 calls, 78.3%** timed out (matches "~805"/"~78%" almost exactly). Audit root: **788/1058 = 74.48%**, reproduced to the token by an independently built parser. Our battery: dev **67.1%**, spinout **60.2%** — genuinely lower, but not "materially" so. Reframe (not a fix-after-the-fact): the rate tracks the mismatch between a 10/20/30s poll timeout and how long a real unit of subagent work takes, not session scale. Source recon sharpened the fix: `wait_agent` is an *event subscription* with a 1-hour max timeout, and completed children push FINAL_ANSWERs into the controller mailbox with no wait needed while local work remains. |
| **E8** — close_agent hygiene (MINE) | Drew's sol controllers 0/86 vs codex-5_5 18/18; near-zero closure in the audit populations; our battery controllers do not close children. | **3 of 3 clauses confirmed — the cleanest result in the campaign. Then root-caused to schema.** | codex-5_5: **18/18 (100%)**. sol-5_6 **0/19**; stress **0/84** (0/67 under Drew's denominator — both agree the numerator is zero). Audit high-wait root **0/123**, direct-sol sample **0/16**. Our battery: dev **0/48**, spinout **0/67**. Behavior is **binary, never graded**. Codex source recon resolved the open question: `close_agent` exists only in multi-agent **V1**; V2 (sol/terra presets) has no such tool and auto-evicts finished children (LRU). **0% closure on modern controllers is the harness schema, not indiscipline** — and the "checklist close_agent" recommendation is unexecutable on V2. E8's scorer survives as a V1/V2 schema detector. |
| **E9** — workspace leaks (MINE) | Drew's fractals set leaks in 2 of 4 repos (corrected from the brief's 3 of 4 during pre-registration); our battery shows some nonzero leak rate on both arms. | **Clause 1 confirmed exactly; clause 2 FAILS — a genuine miss.** | Drew: **2 of 4** repos ever added `.superpowers/` paths (4 paths / 1 path), **both self-cured before HEAD** — scorer reproduces the hand count including every SHA and subject line. Ours: **0 of 14** repos leaked, either arm. Plausible (not proven) mechanism: a workspace-internal `.superpowers/sdd/.gitignore` containing `*` in every repo, plus an agent-authored root `.gitignore` commit in 10 of 14. Review-package surface (added in fix round 1): **0 in both corpora** — a census result, not an omission. |
| **E10** — lifecycle truthfulness (Amendment 2) | (a) an empty-output child is recorded as if complete; (b) a killed child is recorded complete; (c) budget exhaustion yields false success; (d) final-message claims match workdir facts. | **All three engineered probes MISSED their predictions in the HONEST direction. Citation integrity clean.** Registered as a real null result with a scoping finding. | (a) **0/2** reps produced a false-complete: both surfaced the blocker explicitly (one completed the task from `spec.md` instead; one reported `Status: BLOCKED` articulately). (b) **2/2** honest FAIL at every layer — gauntlet verdict FAIL, root rollout `task_complete=0`, child never reported back. (c) the judge itself said **"investigate"** and named its own uncertainty rather than asserting a pass. (d) **100% citation integrity** across a 38-run corpus (**18/18** corroborated test-count claims, 0 false file-existence claims) — in direct contrast to the 07-29 long session, which fabricated 2 of its own evidence citations. Scoping finding: Finding 7's worst examples are **soft, in-band, per-agent budget** mechanisms this rig has no config access to; external kills and judge timeouts cannot fake a completion marker. |

## 3. Cross-cutting findings

**1. Fresh-session dispatch pathology was a CLI-version artifact, and it is not skill-version dependent.** E1's baseline model-omission (0/34 explicit) was measured on the eval container's pinned Codex CLI 0.144.4; the spinout branch's own docs gate the `model` spawn param on 0.145+. At the field version 0.146, dev is clean (14/14 isolated + explicit) and so is spinout's root arm (31/31). The v611 arm (superpowers `v6.1.1` at the same CLI) is also clean at 22/22, which rules out "v6.2.0's skills fixed it" — the CLI version was the variable. **Practical consequence: any eval container pinned below the field CLI silently changes the phenomenon under test.** Bumping the container was Amendment 1's first action for exactly this reason.

**2. Depth-2 implementer-spawned reviewers: 9/9, zero counter-examples — the campaign's strongest finding.** Deduplicated by underlying run: 07-29 real desktop session (1) + our `cx-compaction` battery (4) + our `cx-sdd-small` re-score (3, spanning spinout and v611) + the external stress corpus (1). All 9 are also same-task duplicate reviews (a worker-initiated depth-2 review of a task alongside a separate controller-initiated review of the same task). It reproduces across CLI versions, skill versions, scenario shapes, model families, and corpora — ours and other people's. What remains of Codex dispatch pathology after the CLI fix lives *below* the root controller: both model-omissions in the E1 re-test, and the only `fork_turns:"all"` spawn observed anywhere, were child-issued. **Treatment should target worker-issued spawns, not controller-issued ones.**

**3. Wait-polling waste is structural, and source recon named the fix.** 60–80% timeout rates in every corpus with meaningful `wait_agent` use — including a fresh 3-task battery, which kills the "it's a long-session problem" story. The mechanism is a cadence mismatch: the overwhelmingly common `timeout_ms` values are 10/20/30s, and real subagent work units routinely exceed one poll window. Codex source recon then established that `wait_agent` is an event subscription supporting up to a 1-hour timeout, and that completed children push FINAL_ANSWERs into the controller's mailbox — so the treatment is **event-driven waiting** (few long waits, or none while local work remains; the caveat is `trigger_turn=false`, which costs one long wait when the controller is genuinely idle), not better polling discipline.

**4. close_agent is a V1/V2 schema question, not a hygiene question.** The census result was perfectly binary — 18/18 or 0/N, never in between — which is what pointed at schema rather than behavior. Source recon confirmed it: `close_agent` exists only in multi-agent V1; V2 (the sol/terra presets, and anything with `features.multi_agent_v2` enabled) has no such tool and evicts finished children by LRU, so unclosed children cost nothing. A live probe added a wrinkle worth remembering: a host `~/.codex/config.toml` setting `features.multi_agent_v2.enabled=true` **overrides the model-preset default**, so even a V1-preset controller runs V2 under that config. Any future lifecycle eval must read the effective config, not the preset.

**5. Duplication lives in SDD loops, not in finishing gates — and waivers are respected when fresh.** Purpose-built finishing scenarios produced **0/3** duplicate gates and **0/2** waiver violations, with correctly scoped re-verification; the duplicate-gate pathology showed up instead in the SDD-loop corpora (1/23 runs) and, dramatically, in the real 07-29 session (a 9× identical-regression cluster, root re-running implementer checks, final reviewer re-running bundles). The invalidation probe passes on dev, giving the receipts/verification-lease treatment a real regression baseline to beat rather than a hypothetical one.

**6. The ceremony lever is the hard gate's literal text.** E4's census could not answer its primary question (spike tasks never produce tracked code, so "ceremony before first code" has no anchor), but the MICRO answered a sharper one: the *current verbatim* entry-decision paragraph forces a bounded change into FULL ceremony 5/5 times, while both a null prompt and a drafted three-path router differentiate the three task classes perfectly and identically. The bounded/arch census adds that the planning ritual itself is invariant — two docs before code in every rep regardless of class. **Rewriting the gate text is the intervention; adding more guidance is not.**

**7. Lifecycle honesty is a session-length story.** Fresh, short, single-CLI sessions under an independent LLM judge were honest at every layer we could inspect: three engineered failure probes all produced accurate records, and 38 runs of citation claims held at 100%. The one real long session in the evidence base fabricated 2 of its own evidence citations while its *substantive* claims held (6/7 reconciled exactly). The audit's most damaging examples — a reviewer exhausting a 200-tool-round budget and being recorded complete with empty output — require the framework to synthesize a false completion marker under a soft internal limit. An external kill has no marker to fake; a judge timeout produces an honest "investigate". **Reproducing that class needs harness-level access to per-agent budgets, which this rig does not have.**

## 4. What the fix cycle can now grade

Every recommendation below has a scorer that will produce a
before/after number, and a baseline already measured on `dev`.

**On test counts:** the campaign's "265 tests" figure was **221
scorer/parser tests + 44 collections from the ceremony fixture's own
suite**, reached through the `fixtures/ceremony-{spike,bounded,arch}`
symlinks to one shared 11-test suite — the fixture's tests are the
scenario's subject matter, not this campaign's scorer coverage, so the
number to trust for scorer confidence is 221. This fix wave added 8
(`test_score_e7.py`), making it **229 scorer/parser + 44 fixture = 273**
today.

| Treatment candidate | Graded by | Baseline to beat |
|---|---|---|
| **SDD worker-review prohibition** (workers may not dispatch reviewers) | `score_e6.py` (depth-2 spawns by spawner role, same-task duplicate review families); `score_e5.py` for the same-scope variant | 9/9 depth-2 spawns implementer-issued, all 9 same-task duplicates, 0 counter-examples. Target: 0 worker-issued depth-2 spawns with review coverage preserved. |
| **Event-driven waiting** (long/no waits instead of 10–30s polls) | `score_e7.py` (timeout rate, inter-poll cadence, cache-rebill estimate) | 60–80% timeout rate across every corpus; dev 67.1%, spinout 60.2%. |
| **Verification leases / evidence receipts** | `score_e3.py` (duplicate-gate pairs, identical-command repeats per session) + the `cx-finishing-invalidation` probe as the correctness guard | 1/23 duplicate pairs in SDD loops; 9× cluster in the real session; invalidation guard PASSES on dev (must keep passing). |
| **Remediation cap** (bound discover-one-fix-one cycles) | `score_e5.py` (`serial_remediation_cycles`) | (0,1,2) cycles, 2/3 reps. |
| **Frozen re-review SHA** (no mutation under an active re-review) | `score_e5.py` (wave-boundary violation) | 0 violations in the fresh battery — a regression baseline, not a pathology to fix here. |
| **Criterion-backed blocking findings** | `score_e5.py` (gate findings lacking a violated criterion or reachable path) | 0/13 in the fresh battery; the archetype exists only in the 07-29 session. Small-n: do not over-read. |
| **writing-plans invariant matrices** (scope-mismatched defects) | `score_e5.py` (seeded-defect recall by intended scope) | Crisp seeds 3/3; the cross-task-race probe is inconclusive-by-zero by design tradeoff — needs a stronger probe before it can grade anything. |
| **systematic-debugging occurrence fingerprint** | `score_e3.py` (identical-command repeat count per session) | The 07-29 9× cluster; 1/23 in our loops. |
| **finishing-a-development-branch worktree detection + waiver honor** | `score_e3.py` (waiver violations) + `score_e9.py` (workspace leaks) | 0/2 waiver violations, 0/14 leaks — both already clean on dev. Guard against regression, not a live pathology. |
| **Ceremony entry-gate rewrite** (three-path router) | `ceremony-path-micro.py` (path classification) + `score_e4.py` (ceremony census) | A-current forces bounded→FULL 5/5; Z-null and B-three-path differentiate 5/5. Any replacement must match B, and the census must show the two-doc ritual actually varying. |
| **Explicit `model` on child-issued spawns** (e.g. `[agents].default_subagent_model`) | `score_e1.py` (per-spawn explicit-model rate, by depth) | Root spawns already 100% explicit at CLI 0.146 (dev 14/14). The live gap is depth-2: 2/2 child-issued spawns omitted `model`. Beware the model-without-effort trap (effort resets to the model default). |
| **`close_agent` checklist** | — | **Do not ship.** V2 has no `close_agent`; `score_e8.py` is retained as a V1/V2 schema detector, not a hygiene grader. |
| **`codex-tools.md` corrections** (spinout branch) | — (doc fix) | Five claims contradicted by Codex source, enumerated in `docs/2026-07-29-codex-multiagent-v2-capabilities.md`. |

### Known scorer limitations carried forward

Flagged during the campaign rather than silently worked around; each will
bound how far its scorer can grade a treatment.

- **`score_e3.py`** counts duplicate gates as normalized **exact-string**
  repeats. A substring-occurrence count alongside it (the
  `audit0729_adapter.py` two-metric split that resolved the "148 test
  invocations" reconciliation) would catch chained commands the exact
  match misses.
- **`score_e5.py`**'s D4 fix-review-scope classifier does not parse
  compound/chained shell commands, so rep1's `repair_scoped` label is
  **suspect** — likely all 3 reps, not 2/3, show a whole-suite rerun after
  the mid-session report. A real fix needs a shell-command parser.
- **`score_e6.py`**'s `task_family()` prefix convention (`task<N>`/`final`)
  is specific to this campaign's SDD fixture. On any external corpus, a
  zero duplicate-review result is only trustworthy after a
  naming-convention check — confirmed by its correct non-match on the
  external corpus's differently-shaped names.
- **`score_e7.py`**'s cache-rebill figure is an *estimate* (attributed
  where cleanly possible, else a coarse proxy, always labeled), not billed
  truth.
- **`score_e10.py`**'s file-claim extractor uses a per-line negation
  heuristic and carries one known honest residual false positive
  (accepted, not tuned further).
- **`score_e9.py`**'s explanation for our 0/14 leak rate (workspace-internal
  `.gitignore` plus agent-authored root ignores) is plausible and
  consistent with the evidence, but **unproven** — it was not tested by
  removing the guard.
- **`reviewer-recursion-micro.py`** hardcodes an evals-checkout path
  (accepted as-is; it will need an env override before it runs anywhere
  else).

## 5. Process lessons

**1. Three scenario-infrastructure defects, all caught by an early-verdict anomaly rather than by review.** E2's `git-branch main` pre-check (asserted a branch never checked out at scenario end); E4's `tool-called Agent` post-check (asserted the exact behavior the experiment measured, which would have biased the ceremony census toward inflated dispatch); E5's fixture-directory naming mismatch (setup path). All three surfaced as indeterminate verdicts at or near $0, because the first 1–2 reps of a battery expose them. **Two rules earned:** (a) a scenario's deterministic post-checks must never assert a behavioral choice the experiment measures; (b) run `quorum check <scenario>` plus a $0-tier dry run of `setup.sh` before any battery spend. The second rule is what would have caught all three up front.

**2. "Claimed but not run" is this campaign's most dangerous defect class — three specimens, including the coordinator's own.** (i) A pre-commit privacy sweep claimed but not actually executed let a real private task_name into a committed test file. (ii) An E6 report claim ("that Drew occurrence is scoped out") rested on a stale pre-fix scoring run that was never re-executed after the fix landed — the corrected answer was the opposite. (iii) The coordinator's own "both rollouts exist" check was an `awk`-mangled `ls` error read as success, which turned a whole task's verdict from "verified" into "unverifiable" until the corpus was actually located. **Every one was caught by re-running the claimed check, not by reasoning about it.** Verification claims deserve the same skepticism as findings.

**3. Privacy protocol had to evolve twice.** Word-boundary greps missed substrings, so sweeps became substring-aware, with needle sets extracted programmatically from the corpus itself rather than hand-listed. Then this fix wave found the remaining hole: the gitignored SDD workspace had been treated as outside the privacy rule, which stopped being true the moment we decided to track the ledger — its line 33 still carried the literal private string, redacted before the force-add. **Rule: sweep on the boundary of tracking, not on the boundary of directories.** A related result worth keeping: re-auditing the two history-embedded strings per-commit showed they are not equally sensitive (one is distinctive to the private run across six commit trees; the other is a generic SDD label also present in our own corpus, leaked only as an attribution in one commit message). Blanket "N strings leaked" summaries overstate risk; per-string scope analysis is cheap and worth doing before escalating.

**4. Concurrent tasks must not share a working tree when they share an append-only file.** Commit `193167c` swept up another in-flight task's log entry, publishing an E5 RESULT four minutes before `031937f` landed the files it cited. Nothing detected it because each task inspected only its own additions. The ruling was disclose-don't-rewrite (every cited file exists at HEAD), but the fix for next time is structural: one worktree per concurrent task, or serialize the log-append step. **The same shared-tree concurrency also produced the E5 mid-battery incident** (a container teardown/duplicate relaunch that wasted ≈$0.4–0.7 and was caught same-turn) — two independent failures from one root cause.

**5. Subagent monitoring stalls (narrative-tier, uninstrumented).** Long-running battery tasks driven through subagents repeatedly appeared to stall from the coordinator's side — no output for long stretches while the battery was in fact progressing — which cost coordinator attention and prompted unnecessary intervention. This is recorded as a coordinator-session observation only: unlike every other finding in this report it has **no artifact evidence in this repo** and was never instrumented, so it is narrative-tier and should be re-observed before being acted on.

**6. Amendment tasks squatted a task number, and the plan's checkboxes were never maintained — which is why this report was nearly lost.** The plan's Task 13 is the campaign closeout. Amendment 2 then added work that got carried in conversation as "task 13" as well, and from that point the real Task 13 had no owner: five committed forward references pointed at a closeout report that did not exist, and nothing flagged it because **0 of the plan's 61 checkboxes were ever ticked** — the plan was used as a briefing document, not as state. The whole-branch review caught it. **Rules: amendment tasks get new numbers, never a reused one; and if the plan's checkboxes are not going to be maintained, the ledger has to carry per-task state explicitly (this one did, which is why recovery was possible at all).**

**7. Inconclusive-by-zero, applied honestly, is what kept this campaign cheap.** Six of ten experiments hit it on at least one clause. Each time, the registered rule (stop, don't buy more reps chasing the same shape) was followed, and the question was either re-scoped into a scenario that could elicit it (E1 axis B and E2 → E6) or reported as a scoping finding (E4's spike class, E10's soft-budget mechanisms). The alternative — more reps at a shape that produces zero instances — would have burned the budget for no information.

## 6. Budget

Full itemized ledger: `logs/2026-07-28-codex-efficiency.md`, "Budget
ledger" plus its reconciliation block.

| Category | Amount |
|---|---|
| Instrumented, dollar-measured run spend | **$152.34** |
| — E1 family (baseline, treatment, 0.146 re-test, v611) | $79.05 |
| — E2 FULL | $4.01 |
| — E3 (baseline + waiver + invalidation probes) | $3.69 |
| — E4 ceremony census (incl. $4.54 outage-tainted, excluded from scoring) | $21.39 |
| — E5 FULL | $9.28 |
| — E6 (two batteries) | $25.72 |
| — E10 (three probes) | $9.20 |
| Estimated, uninstrumented | **≈$0.8–1.1** (E6 calibration ~$0.4; E5 mid-battery waste ≈$0.4–0.7) |
| **Campaign total** | **≈$153.2** against $1000 — 15% of budget, never near the $250 checkpoint |
| Not quantifiable | E4's ceremony MICRO (45 `claude-opus-4-8` API calls — **cost not captured; deliberately not estimated**) and E2's MICRO (subscription-billed `codex exec`, no dollar split) |
| Zero-cost work | All MINE-tier scoring: parser validation, E7/E8/E9 censuses, Drew cross-validation, the 07-29 reconciliation, and every free re-score |

**Subscription usage:** the `codex_sub` primary window was read before/after
most batteries, from 28.0% at the first E1 rep to 64.0% after E3's
invalidation probe — the last reading taken. One full window rollover
occurred mid-E1-treatment (45.0% → 1.0%); E4's census was the biggest
single-window mover (18.0% → 55.0%). E5's and E10's batteries took no
reading, so the percentages are not a continuous series and no
total-percent-consumed figure can be derived from them. No window ever
approached exhaustion.

## 7. Open items for Jesse

**1. Two history-embedded sensitive strings — rewrite or accept.** Not
equally serious, and the distinction is the point:

- **String 1 (the real decision):** a task_name distinctive to the private
  stress corpus, committed in `test_score_e6.py`, present in the trees of
  **six** commits — `99c5ad7`, `51607a9`, `85725ce`, `d66b8a8`, `befb06e`,
  `f32350b` — removed at `aeb77e6`, never in any commit message. Absent
  from HEAD. A rewrite would touch six commits.
- **String 2 (much weaker grounds):** a generic SDD-taxonomy label that
  also occurs in Drew's `sol-5_6` fractals run and independently in our
  own committed battery output at HEAD. Its only history-embedded
  Drew-attributed mention is `aeb77e6`'s **commit message**. The leak is
  the attribution, not the token.
- **Never-swept classes, accepted with rationale during the E9 review:**
  Drew repo/run/branch identifiers across 13 files, 5 SDD report paths and
  8 commit SHAs, and the 07-29 corpus's root UUID plus its host name in
  `audit0729_adapter.py`. These are provenance identifiers rather than
  session content and the campaign judged them citable — but they have
  never been swept, so if your bar is stricter than "identifiers are fine",
  this is the gap.

**2. The `remote-host-g` host key (drop unless you care).** During the 07-29 corpus
hunt, `remote-host-g` was the one reachable-in-principle host that could not be
checked because its SSH host key was unverified. The corpus was
subsequently found on `remote-host-a` and all seven audit claims were
reconciled, so this is moot for the campaign; it stays listed only because
"we never actually looked at `remote-host-g`" is a true statement about the search.

**3. Promotion staging (needs your approval to go anywhere).** The durable
write-ups are **staged, not committed and not pushed**, in the
`superpowers/evals` checkout — see §8. Pushing to `superpowers-evals`
requires your explicit merge confirmation.

**4. Fix-cycle scope.** §4 lists twelve treatment candidates with the
scorer and baseline for each. Two should not ship as written: the
`close_agent` checklist (unexecutable on V2) and any model-explicitness fix
aimed at root controllers (already clean at 0.146 — the gap is child-issued
spawns).

## 8. Promotion staging

Per the plan's Task 13 Step 2, the durable write-ups are copied into the
`superpowers/evals` checkout's `docs/experiments/` convention and **staged
with `git add` only — no commit in that repo, and no push or PR.**
Pushing to `superpowers-evals` requires Jesse's explicit merge
confirmation.

Staged there:

- `docs/experiments/2026-07-28-codex-efficiency-campaign.md` — this
  closeout report.
- `docs/experiments/2026-07-28-codex-efficiency/` — the per-experiment
  verdict reports (`e1`, `e1-retest-cli0146`, `e1-v611`, `e2`, `e2-micro`,
  `e3`, `e4`, `e5`, `e6`, `e7`, `e8`, `e9`), plus the two external-evidence
  reconciliations (`e-audit0729`, `drew-cross-validation`) and
  `corpus-validation`. A subdirectory is a small deviation from that
  directory's flat-file convention, taken because 15 flat files would bury
  it; collapse it if you'd rather.

**Before approving a push, note what travels with these files.** The two
external-evidence reconciliations carry the accepted-with-rationale
provenance identifiers from §7 item 1 — the external corpus's repo/run/
branch names, and the 07-29 corpus's root UUID and host name. That was
judged acceptable inside this research repo; `superpowers-evals` is a
wider audience, and the decision deserves a second look rather than
inheriting the earlier call by default.

**E10 has no report file** to promote — by design (see `DESIGN.md`'s
amendments section). Its verdict travels in this closeout's §2 table and in
the hypothesis log's "E10 RESULT" entry, with raw data in
`out/e10-battery.json`.

Not promoted, deliberately: scorers and tests (they belong with the
campaign, and they read paths specific to this machine's corpora), raw
per-rep JSON (aggregates are in the reports), and everything under
`.superpowers/sdd/` except the ledger, which is now tracked in this repo.
