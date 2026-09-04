# Quorum campaign platform: comparative evals as configuration

**Forward direction (2026-09-04):** Drew accepted the
[campaign consolidation direction](2026-09-04-campaign-consolidation-design.md).
It retains comparative questions as configuration, chooses one V2 execution
and evidence model, and pauses V1-specific D4b integration. Its detailed design
is pending written review. This document remains the V1 contract and historical
plan; its remaining delivery sequence is superseded for consolidation planning.

**Date:** 2026-08-17 (revision 3, 2026-09-04)
**Status:** APPROVED (Drew, 2026-08-17) — the governing plan for
PRI-2874. Revision 2 incorporates the seven-seat, two-round adversarial
review of revision 1 (record:
`docs/experiments/2026-08-17-platform-spec-adversarial-review.md`; zero
convergent findings vetoed, all folded in) plus two verification passes.
**Revision 3 (2026-09-04, Drew)** retires the release-binding framing.
Nothing the platform emits binds a release: a decision profile's verdict
is a pre-registered, machine-computed readout, and the release decision
stays a human call over that evidence — as it has been for every release
to date, the 2026-08-09 gate included ("this gate is one input",
`docs/experiments/2026-08-09-fresh-release-gate-readout.md`). The
**qualification campaign is retired as a formal prerequisite**: the
engine reliability it existed to buy has since been demonstrated by use
(two sealed live campaigns, 286 runs, zero instrument failures,
2026-09-02/03), and the 2026-08-09 hand readout from the immutable run
dirs proved the downside of a platform hole is bounded at re-analysis
cost. Its one genuinely unexercised surface — skew exclusion and reserve
draw under a gating profile — is accepted as known risk: the first
gating campaign starts small as ordinary practice, not as a program
gate, and a discredited gate now costs a re-run, never a wrong release,
because no verdict binds one. Contract and profile identifiers
(`release_gate_v1`, SHIP/NO-SHIP) are code-facing names and unchanged.
**Tracking:** PRI-2874 (umbrella; child stubs PRI-2875/PRI-2876 to be
re-scoped at kernel-build kickoff)
**Supersedes:** `2026-08-12-quorum-overhaul-program-design.md` — see
"Relationship to the superseded program" and Appendix A for exactly what
that means, mechanism by mechanism.
**Review basis:** the 2026-08-17 direction panel + smevals gap analysis
(`docs/experiments/2026-08-17-platform-direction-panel.md`), the
2026-08-17 spec adversarial review (record above), the PRI-2874 review
record, and the corpus/experiment evidence cited inline.

## How to read this document

Quorum can answer one shape of question well (scenario × agent pass/fail)
and answers every other shape — harness vs harness, superpowers vs stock,
model vs model, PR vs base — with bespoke dev work per campaign. This
design turns those questions into configuration. The operator surface:

```
quorum campaign register suites/harness-compare.yaml
    # expands the suite into a priced, hashed list of runs; prints the
    # priced grid, exclusions, and digest; asks for confirmation
quorum campaign run campaigns/<id>/
    # buys the list in contemporaneous two-arm blocks; resumable after
    # any crash by re-running the same command
quorum campaign report campaigns/<id>/
    # machine-computed comparison; SHIP/NO-SHIP only from a named
    # decision profile on a gating campaign
quorum campaign list | status <id> | cancel <id>
    # discovery, mid-run progress (progress and spend ONLY — never
    # outcome data before seal), and cancellation
```

An **arm** names a setup, a **suite** names a question as a set of
**comparisons** over arms, **registration** freezes a suite into a priced
list, the **dispatcher** executes it in paired blocks, and a **decision
profile** answers the gating question with reviewed, golden-tested
statistics. The release gate stops being architecturally special: it is
one saved suite binding `release_gate_v1`. Wall-clock and cost are
platform properties, not goals: the 8-hour gate falls out of scheduling
and configuration, not new infrastructure (see Background, finding 3).

## Goal

One platform where any comparative question about superpowers is a
configuration change, runnable at any scale, with validity enforced by
schema instead of operator discipline. Motivating questions, all
currently requiring per-campaign engineering:

- Did this superpowers PR regress anything? (PR ref vs base ref)
- How does superpowers-on-claude compare to superpowers-on-codex?
- What does installing superpowers change vs the stock agent?
- Which model performs best with superpowers?

Success criteria:

1. **Expressibility.** Each question above is expressible as arm + suite
   documents and runs without writing TypeScript. A checked-in example
   suite exists for each of the four questions.
2. **Ceremony.** Posing a new comparative question — from blank editor to
   accepted registration — takes a maintainer under 30 minutes and zero
   changes under `src/`. This is the criterion that measures the actual
   diagnosis (campaigns were bespoke engineering projects); speed without
   it rebuilds a faster ceremony.
3. **The gate.** The checked-in `suites/release-gate.yaml` — which must
   reproduce the 2026-08-08 gate's real structure (per-cell n, per-arm
   participation, cell classes) and is the acceptance workload; its
   registration digest, not "~388 runs", is the acceptance definition —
   completes, registration-accept to sealed report, inside 8 elapsed
   hours.
4. **Machine reports.** Every published readout links its sealed
   `report.json`; a published number not derivable from a sealed report
   is a defect. (This retires the `bc104d0` class — a readout whose
   by-hand statistics were wrong and had to be retracted.)

## Background: why this replaces the 2026-08-12 program

Unchanged from revision 1 in substance; kept brief. The 08-12 program
correctly diagnosed the problems and prescribed a durable multi-operator
supervisor and a VM fleet. The 2026-08-17 direction panel (seven seats,
four model families, adversarial briefs) converged on three findings:

1. **The validity spine is the product and stays.** Every validity
   mechanism exists because we paid for a specific failure: the 08-06
   gate went GREEN and was discredited ($650; wrong codex model,
   answer-key leak, cross-run leak), forcing an $850 re-gate; two
   published readouts carried retractions; check holes produced false
   passes; a 429 latch silently dropped 30 cells. The lab's failure mode
   is never "down for a day" — it is "up and lying."
2. **The availability machinery was padding for this lab's shape.**
   Lease fencing, recovery epochs, boot-nonce identity, RPO=0 barriers,
   multi-operator fairness proofs, and the fleet defend against failures
   whose cheapest handling for two trusted operators is "rerun the
   affected blocks" (worst case one campaign, ~$850, one night — the
   08-08 gate survived a mid-battery laptop reboot on run-dir durability
   alone).
3. **Probe-first.** The 2026-08-12 OpenAI probe showed the observed 5-way
   concurrency ceiling was our harness's own configured limit (zero 429s
   at 20-way); 10.28× parallelism was already achieved at `--jobs 12`;
   the 08-08 slowness was 66 sequential lock-holding jobs. Three panel
   seats independently estimated the gate at ~4.5–7 elapsed hours with no
   supervisor.

The operator-experience finding: evals run only before releases because
of **ceremony, not speed** — hence success criterion 2. The smevals gap
analysis confirmed "contracts donor, not a dependency"; four smevals
designs are adopted near-verbatim (Config-as-arm, failed-run doctrine,
immutable-run-dir storage semantics, the check-result extension).

The revision-1 adversarial review (seven seats, two rounds) established
that revision 1's kernel shape was sound but its schema could not express
the real release gate, its admission model omitted the Gauntlet-Agent,
its two headline questions had no provisioning path, and roughly a dozen
receipt-backed mechanisms from the superseded spec had been dropped
without disposition. All of that is repaired below; Appendix A records
every disposition.

## Design

### Concepts

**Arm** — a named YAML document describing one setup under test:

```yaml
# arms/claude-superpowers.yaml
agent: claude              # coding-agent name (coding-agents/<name>.yaml)
credential: opus_bedrock   # names a credentials.yaml entry; model rides here
superpowers: v6.1.0        # tag or SHA, or `none` for the stock agent
os: linux                  # optional; validated against agent/credential/scenario os support
labels: {}                 # optional, free-form, reporting only
```

There is deliberately no `model:` field — see "Known coupling" below.

**Suite** — a named, reusable question, expressed as **comparisons**:

```yaml
# suites/harness-compare.yaml
kind: exploratory                 # exploratory | gating
budget_usd: 150                   # all-in soft ceiling (subject + grader + reserves); see Execution: Budget
comparisons:
  - baseline: claude-superpowers
    treatment: codex-superpowers
    scenarios: tier=sentinel      # selector or explicit list, per comparison
    n: 5                          # default replicates per cell in this comparison
    cells:                        # optional per-cell overrides
      sdd-escalates: { n: 10, class: confirmatory }
      fractals-smoke: { n: 2, class: descriptive }
```

- A **comparison** names one `baseline` and one `treatment` arm (two-arm),
  or a single arm (`arm:` instead — descriptive/qualification units, the
  future sentinel lane). There are no k-arm blocks: a "which model is
  best" suite is several two-arm comparisons against one baseline (or an
  exploratory set of single-arm units ranked descriptively, confirmed
  pairwise if needed). This mirrors the real 08-08 gate, which was four
  credential-stratified two-arm comparisons — not one 8-arm cohort.
- Per-comparison scenario participation + per-cell `n` and `class`
  (`confirmatory | probe | tripwire | descriptive`, the 08-08 vocabulary)
  make the real gate's heterogeneous, asymmetric grid expressible. A
  scenario dropped by a `# coding-agents:` directive is dropped **within
  its comparison** for both arms (loudly, in `excluded_cells`) — other
  comparisons are unaffected, so asymmetric grids survive.
- Gating suites additionally carry `profile:` + numeric profile
  parameters, `reserve:` (spare blocks per cell), and
  `max_exposure_skew:` (see Execution; the name reflects that skew is
  measured at exposure, not process start). Exploratory suites may also
  set `max_exposure_skew:` (breach = rendered caveat) and may omit
  `reserve:` (default 0). (Example documents in this section elide the
  `schema_version` and `name` fields Appendix B requires.)

`kind` is the campaign's evidence class:

- `exploratory` — "what's going on?" The report is stamped DESCRIPTIVE;
  the schema has no slot for a ship/no-ship verdict.
- `gating` — "do we ship?" Frozen registration before any run, a
  registered reserve, and a named **decision profile**. The release gate
  is a gating suite.

(Naming lineage: drafted as `rigor: exploratory | confirmatory`; "rigor"
and "confirmatory" were dropped as the suite-kind vocabulary (Drew,
2026-08-17) — "confirmatory" is retained only as the 08-08 cell-class
name, a different axis. "Gating" aligns with the superseded program's
credential classes, gating | observational.)

The v1 `scenarios:` selector is an explicit list or
`tier=<sentinel|full|adhoc>` (the existing story.md tier label read by
`readQuorumTier`, `src/run-all/matrix.ts`). No other selector syntax in
v1.

**Registered campaign** — a frozen instance of a suite. Both kinds are
registered identically; gating additionally validates profile parameters
and reserve pricing. `quorum campaign register <suite>`:

- expands each comparison into **cells** (scenario × comparison — a cell
  holds both arms) and **samples** (cell × arm × replicate); duration and
  cost estimates attach per arm-within-cell (keyed scenario × agent);
  applies the eligibility filters below; resolves every
  ref (superpowers per arm, evals, gauntlet) to SHAs; records the
  campaign's grader credential and model (see Execution);
- **rejects** at registration: arms whose adapter lacks per-arm
  superpowers / `none` support (see Provisioning); gating cells on
  obol-unpriced models (an operator-declared per-token override, recorded
  in `campaign.json`, is the only escape); usd-denominated profile
  parameters when any arm is unpriceable; comparisons whose minimum
  feasible launch cannot meet the registered exposure-skew bound (cap-1 pools,
  spacing that cannot co-launch — infeasible-by-construction pairs are
  refused pre-spend); arm `os` unsupported by the agent, credential, or
  scenario directives; seat/subscription-auth credentials in gating
  suites (the carried-forward admission class, enforced mechanically);
- **filters with loud records**: scenarios whose `requires_superpowers`
  metadata conflicts with a `superpowers: none` arm (dropped for that
  comparison, named in `excluded_cells`); for PR-ref arms, each scenario's
  registered `coupling` class (`pins-skill-names`,
  `embeds-skill-fixtures`, `arm-independent`) — coupled cells are flagged
  so the report can segregate "the check pins what the PR changed" from
  "the PR regressed behavior";
- attaches per-arm-within-cell duration and cost estimates from the
  estimate artifact (fallback: scenario×agent median → scenario median →
  corpus median, each tagged `estimate_confidence`); low-confidence
  estimates take a declared surcharge in budget pricing;
- prints the priced grid, exclusions, flags, and digest to stdout and
  asks for confirmation;
- hashes the canonical form (Appendix B defines the canonical bytes —
  estimates and estimate-derived pricing fields are NOT part of the
  digest; the frozen grid, refs, arms, profile, parameters, reserve,
  skew bound, and the registered `budget_usd` are — runtime raises live
  only in the journal, so the effective budget is registered + journaled
  raises). The digest is the
  campaign's identity; a changed grid is a new campaign. Re-registering
  an unchanged suite with an unchanged resolution is idempotent (same
  digest → same campaign directory).

Registration is the entire ceremony — no design doc, no power tables, no
scratchpad driver.

### Identity

The chain, as zod schemas in `src/contracts/` (Appendix B):

```
campaign_id (registration digest)
  └─ comparison_id
       └─ block_id        the contemporaneity unit: one replicate of ONE
          │               CELL of the comparison (both arms), co-admitted
          │               and co-launched
          └─ sample_id    one arm's slot within the block
               └─ execution_attempt_id   journaled BEFORE spawn
                    └─ run_id            bound at run-dir allocation
```

Cardinality: a two-arm comparison's block holds two samples; a single-arm
unit's block holds one; every sample belongs to exactly one block. Every
verdict gains a campaign identity sub-block (campaign, comparison, block,
sample, attempt ids), stamped by the runner **before the first provider
token** — the runner emits `run_allocated: <run_id>` on its child
protocol at run-dir allocation (today it prints run-id only at exit;
this is the one required runner change, `src/cli/run-command.ts` /
`src/runner/index.ts` `onRunDir` seam).

### Storage semantics (adopted from smevals, near-verbatim)

- Run dirs stay immutable, in `results/`, completion marker written last.
- Post-completion additions are append-only under the run dir (the
  regrade door, not built now).
- **Failed-run doctrine:** a typed instrument failure is never evidence —
  never graded, excluded from analysis n, its slot refilled by the frozen
  outcome-independent replacement rule (both kinds). `indeterminate`
  remains distinct: evidence ambiguity, reported in full, never silently
  replaced. The exact four-way mapping from the code's real outcomes to
  {instrument (replace), evidence, aborted, shortfall} is a kernel
  deliverable — see Typed failures.
- A campaign directory (`campaigns/<digest-prefix>-<suite>/`) holds
  `campaign.json`, the journal, and the sealed reports, referencing runs
  by `run_id`. Nothing moves; "quarantine" is a journal classification,
  never a filesystem move.
- **Erratum path:** a sealed report is never edited. Corrections are
  append-only errata in the campaign directory; a regenerated report
  carries a `supersedes:` chain with the original preserved — the 08-09
  inline-CORRECTION convention, mechanized. (The last two published
  corrections were instrument blindness, not arithmetic; sealing does not
  retire that class, so the platform must accommodate honest correction.)
  Revision 3: the principle stands; the general mechanism is built on
  first need, not before. The only sanctioned supersede path in v1 is
  D4b's single-purpose tripwire-ruling re-render.

### Checks: adopting smevals' check-result extensions

`CheckRecord` keeps `{phase, check, args, negated, passed, detail}` (note
`phase` is load-bearing and retained) and gains optional `score`,
`metrics`, `tags`, `notes`; unknown keys fold into `detail` (a write-side
rule, implemented, not a zod default). Metric aggregation is
registration-scoped: only metrics declared in the suite (name, unit,
aggregation) are pooled; undeclared metrics render per-check only —
open-vocabulary pooling of identically-named metrics from different
checks is not meaningful.

**Expected-check manifest (fix-now, prerequisite for gating):** per
scenario used in any gating suite, a frozen exact multiset of
`{phase, check, args, negated, multiplicity}`; conditional check paths
must be declared as alternates (audit `checks.sh` files for shell
conditionals before freezing the format). The composer returns a typed
instrument failure — never `pass` — unless actual records match. An empty
expected post-check set is illegal for gating scenarios. Planted-negative
fixtures must cover **both families**: filesystem verbs via known-bad
fixtures AND transcript verbs via mutated ATIF trajectories (drop calls,
insert prohibited calls, reorder) — 65 of 85 scenarios use transcript
checks; fs fixtures alone close a third of the hole.

### Decision profiles (replaces revision 1's draft predicate grammar)

There is **no user-authored predicate language**. A gating suite names a
**decision profile**: a versioned, code-reviewed TypeScript module in the
platform, with golden-oracle tests, that consumes the sealed campaign
data and emits the decision. Suites bind a profile and its declared
numeric parameters (alphas, floors, deltas); registration validates the
parameters against the profile's schema. Growing the profile list — or a
profile's vocabulary — is a platform PR with test coverage, never a
campaign-time extension. (The adversarial review was unanimous here: a
closed grammar rich enough for the real gate is a statistics package
authored in YAML, which is how hand-computed statistics return.)

**Framing (revision 3):** the verdict a profile emits is a computed,
pre-registered readout — it binds nothing. A human reads the report and
decides; the profile exists so the evidence under that judgment is
tamper-evident and cheap to re-check. SHIP/NO-SHIP name readout values,
not platform acts.

v1 ships two profiles:

- **`release_gate_v1`** — scope: a campaign of two-arm comparisons.
  Semantics (all pre-registered as parameters): per-cell Fisher exact,
  two-sided, on confirmatory cells; RED on any treatment-unfavorable
  significant confirmatory cell; per-cell determinate-n floors (a cell
  below floor reads UNDERPOWERED and joins the cannot-answer list — it
  cannot RED the gate); tripwire-class rules evaluated at seal — both
  fired tripwire cells and the 08-08 completion-collapse rule (cross-arm
  completion divergence beyond its registered threshold), which is
  encoded as a tripwire-family profile check; probe and descriptive
  cells never gate; missing or unevaluable quantities are fail-closed
  (never silently false). **The profile mints `investigate` at seal**: a
  fired tripwire seals the campaign with the verdict
  UNDERPOWERED-or-INVESTIGATE; SHIP can appear only in a superseding
  report (a journaled superseding re-render, not a general errata
  apparatus — revision 3) after a recorded append-only
  **adjudication entry** — a journal event distinct from amendments —
  resolves the fire. The human step is visible in the journal, never
  laundered, and never blocks sealing. The sealed verdict is
  three-valued: **SHIP / NO-SHIP / UNDERPOWERED-or-INVESTIGATE** — a
  behavioral failure and a dead instrument are never conflated. Every
  SHIP renders the pre-registered minimum-detectable-effect per
  confirmatory cell ("what this gate cannot answer", as schema) — the
  gate ships on absence of unfavorable evidence, and the MDE line is
  what makes that honest at n≤10, where equivalence testing would be
  vacuous.
- **`descriptive_v1`** — the exploratory report: rates, token/dollar
  medians, tags/metrics, accounting; DESCRIPTIVE stamp; the report
  schema's verdict slot is structurally absent for this profile.

### Execution

**The block is one replicate of one cell of a comparison** — the
baseline and treatment samples of one scenario, co-admitted and
co-launched (single-arm units degenerate to one sample). A cell with
n=5 is five blocks.
Contemporaneity is per-comparison; cross-comparison transitivity was
never same-moment and is not claimed.

- **Admission is atomic per block**: slots reserved in the baseline arm's
  pool, the treatment arm's pool, AND the campaign's **grader pool**, or
  the block waits. The Gauntlet-Agent is the second LLM in every run
  (median 75s/run, 34% of drive; ~$149 of the $850 gate) — 388 samples ×
  75s ≈ 8.1 serial grader-hours, so an unmodeled grader pool defeats the
  8-hour criterion by itself. The campaign's grader credential and model
  are registered, pooled, capped, admitted, simulated in Phase 0, priced
  into `budget_usd` (which is **all-in**: subject + grader + reserves),
  and recorded in provenance. `--grader-model` overrides are rejected on
  campaign runs.
- **Skew** (three rules, all from the review): (1) measured from each
  arm's **first Coding-Agent generation request** (`analysis_exposure_
  started_at`, restored from the superseded spec) — spawn and Gauntlet
  boot are not arm start; (2) registration rejects structurally
  infeasible pairs pre-spend; (3) at runtime in a **gating** campaign, a
  block whose exposure skew exceeds the registered bound is **excluded
  from the paired comparison and refilled from reserve** (the runs are
  retained as evidence — the data isn't broken, it's validity-compromised
  for pairing), reaching the typed `exhausted` terminal if reserve
  exhausts; in
  **exploratory** campaigns a breach is a rendered caveat. The registered
  bound derives from the drift timescale (±25 pts over *hours* ⇒ bounds
  in tens of minutes are conservative), with Phase 0 informing the
  achievable floor. One review seat dissents (breach-as-caveat
  everywhere); recorded in the review record.
- Dispatch is longest-expected-first from the frozen estimates (sdd/
  fractals at t=0); greedy under per-pool caps + a global slot cap.
- **Quota pools, v1 derivation:** `quota_pool` key if set, else
  `(base_url ?? credential-name)|api|model` — per-model splitting (the
  probe's conclusion) without merging distinct endpoints or orgs; the
  explicit key covers entries genuinely sharing one provider bucket.
- A 429 puts its pool into a journaled `blocked_until` cooldown; blocks
  wait and resume; the terminal-skip latch is retired. **Sensor reality:**
  rate-limit detection today exists for exactly one harness (the
  Antigravity marker); provider-broad 429 classification — subject CLIs
  AND the gauntlet child's stderr/result — is named kernel work, without
  which the cooldown has nothing to trip it and grader exhaustion burns
  reserves silently.
- A typed instrument failure activates the **replacement rule** (both
  kinds): a fresh full block, never a single arm, never
  outcome-conditioned. Gating suites pre-register `reserve:` blocks per
  cell, priced into the budget; exhaustion is the typed terminal
  `exhausted`, visible to the profile as reduced determinate n. The
  **innocent arm** of a replaced block gets the typed disposition
  `excluded (block_replaced)`; its run dir is retained on disk and
  journal-referenced as `superseded_by` — one included outcome per
  primary slot is a conservation rule the report proves.
- **Budget: counts are the hard bound; dollars are soft.** Registration
  fixes primary + reserve block counts and per-attempt time/count bounds
  exactly — that is the enforceable cap. `budget_usd` is an all-in
  advisory admission threshold: the dispatcher stops admitting new blocks
  when journaled actual spend + estimated in-flight would exceed it;
  overshoot is bounded ≈ one in-flight wave and named at seal. A
  **budget amendment** exists, narrowly: raise-only (toward completing
  the registered plan — the frozen grid cannot be altered), pre-seal
  only, append-only in the journal, rendered in the sealed accounting
  block; and `campaign status` never displays outcome data before seal,
  so an amendment cannot be conditioned on rendered evidence. Truncation
  needs no amendment: cancel exists and a cancelled campaign seals no
  decision. (Review split 3–2 on amendments; Drew ruled raise-only-with-
  guards, 2026-08-17. The superseded hard-commitment-cap invariant is
  consciously not carried — Appendix A.)
- **Cross-process enforcement:** the journal writer holds an exclusive
  flock on the campaign dir; a **host-wide live-spend lock** is shared by
  `campaign run`, `run-all`, and direct `quorum run` (children inherit
  ownership) — pool caps are meaningless across processes without it;
  v1 gating campaigns run on **one designated host** with the blessed
  bundle, and workstation use of that bundle during a gate is forbidden.
  Cross-host pool leases are explicitly deferred until simultaneous
  multi-host campaigns exist.
- **Contention guard (replaces the superseded per-run resource classes):**
  the designated host's fingerprint (CPU/mem/disk shape) and the fixed
  global concurrency are registered; a resource-floor preflight gates
  launch; campaign-level CPU/mem/swap/PID/disk telemetry is recorded with
  declared invalidation thresholds. Per-run cgroup classes return only if
  a campaign shows contention-induced drift or a campaign studies
  resources deliberately (revision 3: was "if qualification shows...").
- Cancellation (SIGINT/SIGTERM/SIGHUP) kills the process group, marks
  in-flight blocks aborted; `campaign run` is the idempotent resume verb
  and reruns them whole.

**Sealing:** the completeness predicate runs over the journal — every
registered sample terminal; every primary slot included, replaced by
rule, or in a typed terminal state (`exhausted`, `budget_stopped`,
`skew_excluded`) that the report names; nothing pending or
silently omitted — then the profile evaluates (minting `investigate` in
the verdict where its tripwire rules fire — a verdict state, not a
pre-seal slot state), and `report.json` is
written last (temp + fsync + atomic rename; `report.md` first, JSON
last) as the completion marker. `campaign report` on an unsealed
campaign prints exactly which samples block sealing and why.

### Journal and recovery

SQLite, in the campaign directory (the review converged: once early
binding, pgid state, cooldowns, status queries, and errata references
exist, SQLite is simpler than a checksummed-JSONL replay reducer; the
store is nevertheless subordinate to the **journal contract** in
Appendix B — event vocabulary, state machine, fsync-per-transition,
`schema_version` row, single writer under flock). Rows: block/attempt
state, attempt→run bindings, **process-group ids**, pool cooldowns,
spend, amendments, adjudications.

Recovery: crash → restart → **kill journaled pgids first** (an orphaned
child keeps spending and races its replacement) → reconcile journal
against run dirs → keep completed blocks → rerun in-flight blocks whole →
quarantine (journal-classify) late or orphaned run dirs by attempt-id
mismatch. Host loss → new host, rerun incomplete blocks. Worst case is a
full campaign rerun (~$850, one night). No leases, no fences, no epochs,
no boot nonces: the recovery unit equals the validity unit. Crash-window
behavior (mid-registration staging, pre-spawn, pre-run-allocated,
mid-seal, ENOSPC → `storage_paused`) is specified in Appendix B's state
machine; registration builds in a staging dir and publishes
`campaign.json` atomically last.

### Report engine

`quorum campaign report` reads the journal **plus the referenced
immutable run dirs** and is deterministic over those inputs (per-host
byte-stability; golden-oracle tests over synthetic journal + run-dir
fixtures; the Fisher implementation checked against independently
generated golden tables — no second live implementation (revision 3);
rounding and key order specified in Appendix B). The
descriptive vocabulary is fixed and closed:

1. Per-comparison pass-rate deltas — per-cell Fisher exact (two-sided)
   plus the profile's aggregation; raw cross-cell pooling renders as
   descriptive only (the superseded doctrine, kept).
2. Token and dollar medians over matched determinate cells (per
   comparison).
3. The accounting block — instrument errors, indeterminates,
   replacements, reserve draws, skew exclusions and caveats, budget
   events and amendments, denominators — always rendered, never
   elidable.
4. Declared-metric aggregation and tag shares, descriptive only.

Every number carries n, denominator, coverage, and cell class.
**Provenance:** registered vs **observed** model per arm — where observed
is the recorded *set* of models in the trajectory (codex parents
routinely invoke sol/terra/luna subagents; a singular field would lie) —
plus the campaign's registered grader credential/model and the observed
grader identity. A mismatch is a loud provenance failure of the affected
cells. Unpriced arms render tokens-only with a named coverage caveat
(exploratory only; gating rejected them at registration).

The dashboard is untouched by this design; campaign runs appear as bare
cells and new-credential arms may be invisible under a loaded manifest —
`campaign status` is the mid-run surface of record. Teaching the
dashboard campaigns is backlog-eligible, not committed.

## Provisioning: per-arm superpowers materialization (named kernel scope)

The platform's two headline questions (PR-vs-base, superpowers-vs-stock)
require what no adapter can do today: every adapter reads host-global
`SUPERPOWERS_ROOT` and hard-fails without it. Kernel work item, sized
honestly (it touches all 9 adapters):

- Registration resolves each arm's `superpowers:` to a SHA; the
  dispatcher materializes **one immutable worktree per distinct SHA**
  under the campaign directory and passes its root per child (env
  injection through the existing `command-runner` seam) — two arms of one
  block run from two different checkouts on one host, contemporaneously.
- `superpowers: none` is a first-class adapter mode that suppresses
  skill/plugin/hook staging entirely.
- Registration **rejects** `none`/ref arms for agents whose adapter has
  not implemented the mode.
- Black-box test per adapter: the run's provenance readback
  (`verdict.json .provenance.superpowers_rev`) equals the arm's
  registered SHA — or is absent for `none`.

## Instrument snapshot (campaign-local)

Registration pinning names is not pinning the instrument: the runner
reads `story.md`, `checks.sh`, and the prelude from mutable paths at run
time, so a mid-campaign edit can yield old pre-checks and new post-checks
under a report claiming the registered SHA. The dispatcher, scenarios,
checks, prelude, agent configs, dependency lockfile, and Gauntlet build
execute from a **campaign-local materialization of the registered evals
SHA**; drift detected against registered digests halts admission and
invalidates the affected block. This retires the procedural freeze rule
for campaign runs (it remains for legacy `run-all` use).

## Typed failures (named kernel scope with an acceptance bar)

The failed-run doctrine's plumbing does not exist yet and is scheduled
work, not an assumption: the spec's failure classes must map onto the
**real** `RunError` enum (`setup | gauntlet | capture | checks | compose
| qa-agent-misconfigured | stopped | unknown` — "infra" and
"grader-credential" are not stages today); the closed map
composer-outcome → {instrument (replace), evidence (indeterminate/pass/
fail), aborted, shortfall} is a published kernel deliverable; grader
billing-exhaustion and grader 429s — which today compose to
`indeterminate` with no error and hit 2 of the last 3 batteries — become
typed instrument causes; provider-broad rate-limit classification covers
subject CLIs and the gauntlet child. Unknown causes remain `indeterminate`
and are **never** replaced (outcome-independence lives or dies on this
trigger set). **Acceptance bar:** the first gating campaign's accounting
block shows instrument-error and indeterminate rates; an indeterminate
share above 5% triggers a reliability fix before any campaign is relied
on for a release (the superseded W1 exit, restored as a live bar).

## Known coupling: model ⇔ credential (documented punt)

Unchanged from revision 1: model rides in the credential; no arm-level
`model:`; single quota/pricing authority; the 08-06 wrong-model receipt;
observed-model readback as the guard; two-YAML-lines cost per model;
revisit triggers (arm-level override need, or two-entries-per-model
burden); the arm schema versioned so `credential:` can become
`endpoint:` + `model:` without touching suites. Pointer comment lives at
the top of `credentials.yaml`.

## Phase 0: the free capacity simulation

No live spend; the ~$850 live probe remains rejected (Drew, 2026-08-17).
Replay the 08-08/09 gate's recorded durations through the dispatch
policy — **including the grader pool as a first-class dimension** (its
absence would understate the critical path of every configuration) —
across pool caps {5, 15, 20} × global jobs {8, 12, 20, 24}, publishing
predicted makespans and per-pool critical paths as a checked-in
experiment entry. Phase 0 also emits the **estimate artifact** (per
scenario×agent durations and costs, with a refresh rule) that
registration consumes, and informs the skew bound's achievable floor.
What simulation cannot prove is validated live by the first real gate
(revision 3: the qualification campaign is retired).

## Qualification before the first gate

**Retired (revision 3, 2026-09-04) — rationale in the status block.**
The qualification campaign is no longer a prerequisite to the first
gating campaign; the first gating campaign simply starts small. The
original requirement is kept below as the record of the reasoning that
produced it — its motivating receipt (a discredited $650 gate, an $850
re-gate) remains the argument for pre-registration and fail-closed
evidence, both of which revision 3 keeps.

> Between kernel completion and the first release-blocking 388-sample
> gate, a **bounded qualification campaign** (~⅓ gate scale, registered
> like any gating campaign but not release-binding) exercises every arm
> kind (ref, `none`), every credential/pool including the grader, the
> slow-cell families, replacement and reserve draw, skew measurement and
> exclusion, model readback, the contention guard, provider 429 handling,
> cancellation, and crash-resume — and must clear the <5% indeterminate
> bar and the planted-negative proofs. It does not prove the 8-hour
> makespan (the 388 is that proof); it proves the instrument is safe
> enough to buy the 388. The $650 discredited gate followed by the $850
> re-gate is the receipt for exactly this sequencing.

## Coexistence and sequencing

Everything lands additively. `run-all`, the appliance, and the dashboard
are untouched; any future retirement decision for `run-all` waits until
the campaign path has demonstrably replaced its jobs and is not made
here. The executor boundary (review-settled): a **thin campaign
dispatcher** sharing the existing execution/provisioning primitives
(clock, credential snapshot, child-arg construction, run spawn) — two
schedulers, one execution primitive; `runSchedule` is not generalized in
v1; unification is a post-first-seal decision. The appliance's fate is
decided after Phase 0 and the first gate, from measurements.

**Order of operations:**

1. **Fix-now items** (independent PRs, this week, any direction):
   - Per-agent env **and filesystem** credential scoping (F13, 2026-08-12
     adversarial review: 6/12 launchers inherit host env; the Gauntlet
     subprocess env carries the full provider bundle; the container's
     credential env file and OAuth mounts are readable under the agent's
     UID). Done when a per-agent black-box test proves the agent reaches
     only its own credential, by env and by filesystem.
   - The composer false-pass hole (`src/composer.ts`: Gauntlet pass +
     zero post-checks → `pass`), closed by the expected-check manifest +
     both planted-negative families (see Checks).
   - `import --force`'s unconditional recursive destination delete
     (`src/appliance/import.ts`) replaced by the exact contract: absent →
     stage/verify/atomic-rename; byte-identical → idempotent skip;
     conflict → typed rejection, committed evidence untouched; quarantine
     applies only to the incoming staged payload.
   - Results volume growth + guarded `prune --dry-run/--apply` that never
     touches runs referenced by **any campaign, sealed or unsealed**
     (sealed reports are deterministic over their run dirs; pruning them
     kills regeneration and the post-hoc re-inspection the 08-06
     discreditation required). Campaign-run deletion waits for an
     explicit archive/retention contract.
2. **Phase 0 simulation** (~days) + the estimate artifact.
3. **Kernel build** (~5–7 weeks; grown honestly by the provisioning and
   typed-failure scope): contracts appendix schemas → provisioning +
   instrument snapshot → dispatcher + journal + locks → profiles + report
   engine. TDD throughout.
4. The **first registered gating campaign** — the live validation and
   first ≤8h attempt, starting small (revision 3: the qualification
   prerequisite is retired).
5. The **ranked backlog**, gated on **kernel shipped + first campaign
   sealed** (not the ≤8h pass — the daily-driver lane needs the
   dispatcher, not the throughput proof): scrub-at-capture + long-lived
   token rotation (named owner) **as a hard gate before** the smevals
   static-site export adapter → suite registry + the self-running
   single-arm sentinel suite (the merge-time lane) → offline regrade →
   diff-driven scenario selection. (Dashboard campaign views:
   deliberately absent — decision, Drew 2026-08-17: campaign-reading
   surfaces build on the export-adapter side, in smevals' vocabulary,
   not on the legacy dashboard, which stays a passive grid; revisit only
   if operator appetite appears after the adapter ships.)

## Testing

The repo's culture, no mocked-behavior tests: dispatcher/journal against
the injectable clock and a fake runner seam; crash-recovery tests that
kill mid-block and assert pgid-kill-before-rerun and no-double-spend; an
adversarial-arrival scheduler test (mixed-size comparisons sharing
pools); golden-oracle profile and report tests (synthetic journal +
run-dir fixtures; independent Fisher cross-check; MDE rendering); the
planted-negative fixtures of both families; schema round-trips for every
Appendix B document; `quorum check` validates arm and suite files
including profile parameters; the standing 2-scenario live exploratory
smoke, named suite, run before every gating campaign, trusted-maintainer
only.

## Non-goals

- No supervisor, no fleet — unless a named gate fails (a gating campaign
  misses 8h for control-plane reasons, or per-attempt credential
  isolation becomes a hard requirement). The superseded spec's W2/W6
  material is the recorded restart point; otherwise the disproof lands in
  the experiment log at equal billing.
- No multi-operator admission control: the host locks above, FIFO, and
  two humans who talk. Operator identity is a recorded label.
- No user-authored decision language, ever, in gating campaigns.
- No k-arm atomic blocks.
- No amendments other than raise-only budget (grid, profile, parameters,
  reserve, skew, and the registered budget figure are digest-frozen;
  changing them is a new campaign; raises accumulate in the journal
  only). Tripwire **adjudications** are a distinct permitted append-only
  journal record, not an amendment.
- No per-attempt dollar kill (no live metering exists; time/count bounds
  cover runaway attempts) — recorded drop, Appendix A.
- No dashboard changes; no dashboard launch UI (standing decision).
- No retroactive migration of historical results into campaign identity.
- No regrade, export, or diff-driven selection in the first release.
- Live evals remain trusted-boundary; nothing here goes to public CI.
- Windows and Antigravity remain on their separate trusted-maintainer
  paths (arm `os: windows` is a registration error until then).

## Relationship to the superseded program

Unchanged in substance from revision 1: `2026-08-12-quorum-overhaul-
program-design.md` is superseded as the governing plan (staging, gates,
criteria, supervisor/fleet scope); its validity doctrine is carried
forward — now with the mechanism-level accounting the revision-1 review
demanded in **Appendix A**, which records every sub-supervisor mechanism
the old spec carried, whether it had a receipt, and its disposition here
(carried / replaced-by / consciously dropped with reason). Restored by
the review, for the record: `analysis_exposure_started_at`, registration
skew-feasibility rejection, the fused driver/grader pool, per-cell
determinate floors, cell classes, the typed-failure work with the W1
exit bar, the qualification step, grader identity provenance, the
observational-column note (one line: linked-campaign scheduling and
graduation smokes live in re-scoped PRI-2876), and the C/P/T/D
vocabulary. W4 (runner/grader split, rubric-blind driver) continues as
an orthogonal Gauntlet track.

The direction-panel record, the smevals analysis, and the two-round
adversarial review of this document are checked in at
`docs/experiments/2026-08-17-platform-direction-panel.md` and
`docs/experiments/2026-08-17-platform-spec-adversarial-review.md`.

## Appendix A — dropped mechanisms and dispositions

The supersession diff, mechanism by mechanism (review seat K3 B's audit,
adopted). Format: mechanism — receipt — disposition.

| Mechanism (superseded spec) | Receipt | Disposition here |
|---|---|---|
| Skew pre-spend feasibility gate + `analysis_exposure_started_at` | nonstationarity doctrine | **Restored** (Execution: skew rules 1–2) |
| Per-run resource classes / equivalence gates | infra-noise 6pp | **Replaced** by designated-host fingerprint + fixed concurrency + telemetry w/ thresholds; per-run classes return if qualification shows drift |
| Hard commitment cap; unpriceable-work bar | 08-08 estimate 2.1× off | **Replaced** by counts-hard/dollars-soft + unpriced-model registration rejection + surcharge; "never exceeds" invariant consciously dropped |
| W1 exit (<5% indeterminate, zero silent omissions) | 17.5% waste corpus | **Restored** as first-gate acceptance bar; zero-silent-omission via sealing + `excluded_cells` |
| Sentinel ≤2h qualification | $650 invalid gate | **Replaced** by the bounded qualification campaign (different shape, same purpose) |
| Provider-broad rate-limit classification | 30 dropped cells | **Restored** (Typed failures) |
| Gauntlet structured terminal failures | grader-billing masquerade ×2 | **Restored** (Typed failures) |
| Grader pool in admission + longest-chain across both pools; PRI-2524 de-SPOF | grader = 34% of drive | **Restored** (Execution: grader pool); PRI-2524 remains a named dependency |
| Grader identity provenance | 07-09 grader-drift screen | **Restored** (Report engine provenance) |
| Real-workload saturation receipt | probe self-declared synthetic | **Replaced**: qualification campaign + first gate are the live receipts (recorded) |
| Scrub/rotation sequencing gate before sharing | live OAuth in run homes | **Restored** as a hard backlog gate with named owner |
| Observational-column machinery (linked campaigns, graduation smokes) | column-auth research | **Deferred to PRI-2876** (recorded) |
| Interim ≤12h bar | slippage insurance | **Dropped with reason**: the qualification campaign is the stair-step; a capacity miss re-plans against Phase 0 data |
| Registered multiplicity/sidedness/alpha | stats doctrine | **Subsumed by profiles** (two-sided named in `release_gate_v1`; two-arm scope moots cross-arm multiplicity) |
| Pair-block starvation guard + adversarial-arrival test | review P1 #6 | **Test restored** (Testing); mechanism simplified by two-arm blocks |
| Cell-class vocabulary (C/P/T/D) | retraction class | **Restored** (suite `class:` + profile semantics) |
| Per-attempt cost bound | runaway batteries | **Dropped with reason**: no live metering; time/count bounds cover it |
| Adapter phase split (spend attribution half) | F13 | **Dropped with reason**: env+fs scoping covers the credential half; precheck spend attribution not carried |
| Subagent-model registration | 08-06 wrong model | **Restored** (observed model = recorded set) |
| OpenCode indeterminate re-classification | 48% → 8% | **Dropped with reason**: accounting block keeps the rate visible; the <5% bar forces work if it regresses |
| Conservation equations in reports | silent drift | **Partially carried**: one-included-outcome-per-slot proven; full equation set not required |
| Analysis-disposition axes (`analysis_disposition`, `replaces_primary_sample_id`) | P1 #5 | **Carried, minimal form**: `excluded (block_replaced)` + `superseded_by` + the conservation rule |

## Appendix B — contracts (schema sketches, kernel deliverable 1)

Field lists, state machines, and the digest definition an implementer
can TDD against; zod is the source of truth once written. Compact form:

- **Arm** `{schema_version, name, agent, credential, superpowers:
  sha|tag|"none", os?, labels?}`
- **Suite** `{schema_version, name, kind, budget_usd, profile?,
  profile_params?, reserve?, max_exposure_skew?, attempt_bounds?:
  {max_time_s?, max_attempts?} (defaults from scenario `quorum_max_time`),
  declared_metrics?,
  comparisons: [{baseline|arm, treatment?, scenarios, n, cells?:
  {scenario: {n?, class?}}}]}`
- **Campaign** (`campaign.json`) `{schema_version, campaign_id, suite
  (embedded resolved copy), refs: {superpowers_by_arm, evals, gauntlet},
  grader: {credential, model}, cells[] (scenario, comparison_id, arms,
  n, class, coupling, estimates_by_arm: {arm: {duration_s, cost_usd,
  confidence}}),
  excluded_cells[] (cell, reason), samples[] (sample_id, cell,
  arm, replicate), comparisons[] (comparison_id — minted at registration
  as the digest-scoped ordinal — baseline, treatment|arm),
  blocks[] (block_id, comparison_id, sample_ids[]),
  budget: {usd_all_in, surcharge_applied, priced_coverage},
  registered_at, registered_by, digest}` — **digest canonical form**:
  JCS-canonicalized JSON of the campaign minus `estimates_by_arm`,
  `budget.surcharge_applied`, `budget.priced_coverage`,
  `registered_at`, `registered_by`, `campaign_id`, and `digest` itself
  (the hash cannot contain itself); estimates and estimate-derived
  pricing fields are advisory and re-derivable; `budget.usd_all_in`
  (the registered figure) stays in the digest.
- **Journal events** (SQLite; `schema_version` row; fsync per event):
  `campaign_opened, block_admitted(pools[]), attempt_created(sample,
  attempt), run_allocated(attempt, run_id, pgid), exposure_started(
  sample, ts), run_completed(attempt, outcome), instrument_failure(
  attempt, cause), block_replaced(block, replacement_block, cause),
  sample_disposition(sample, disposition, superseded_by?),
  slot_exhausted(sample), budget_stopped(sample_ids[]),
  skew_excluded(block), pool_blocked(pool, until), budget_event(kind,
  amount), amendment(kind=budget_raise, amount, ts), adjudication(
  cell, disposition, rationale), aborted(block), storage_paused,
  sealed(report_digest)` — replay of the event stream deterministically
  reconstructs state; materialized tables are rebuildable.
- **Block/attempt state machine:** `planned → admitted → spawned →
  exposed → terminal{completed | instrument_failed | aborted |
  skew_excluded | excluded_block_replaced | exhausted |
  budget_stopped}`; a `planned` sample reaches the `exhausted` or
  `budget_stopped` terminal without admission via the `slot_exhausted`
  or `budget_stopped` journal events;
  campaign: `registered → running → {sealing → sealed |
  cancelled | storage_paused → running}`. Crash windows resolve by:
  pre-`run_allocated` → attempt void, re-admit; post-`run_allocated`
  without terminal → kill pgid, block rerun; post-seal-predicate
  pre-report → regenerate report (idempotent).
- **Verdict extension:** existing `FinalVerdictSchema` (v1) gains an
  optional `campaign: {campaign_id, comparison_id, block_id, sample_id,
  execution_attempt_id}` block; readers tolerate absence (dashboard
  unaffected).
- **CheckRecord extension:** optional `score, metrics, tags, notes` as
  defined under Checks.
- **Report** (`report.json`) `{schema_version, campaign_id, profile,
  stamp: DESCRIPTIVE?, verdict?: SHIP|NO_SHIP|UNDERPOWERED_OR_INVESTIGATE
  (present iff the profile is gating; structurally absent for
  descriptive_v1), cannot_answer[] (underpowered cells + MDEs),
  comparisons[] (per-cell tables, deltas, fisher_p, mde),
  accounting{...}, provenance
  {arms: registered vs observed_set, grader}, supersedes?, errata[]}` —
  numeric rendering: shortest round-trip doubles, keys sorted, LF line
  endings (the byte-stability contract).
- **credentials.yaml:** `CredentialSchema` (strict) gains optional
  `quota_pool: string` — a schema PR, not just a comment.
- **Scenario metadata:** story.md frontmatter gains `requires_superpowers:
  bool` (default from static scan) and `coupling: pins-skill-names |
  embeds-skill-fixtures | arm-independent` (default from static scan;
  overridable).
