# Quorum campaign platform: comparative evals as configuration

**Date:** 2026-08-17
**Status:** draft — awaiting Drew's review (direction approved in discussion,
2026-08-17)
**Tracking:** PRI-2874 (umbrella; child stubs PRI-2875/PRI-2876 to be
re-scoped at kernel-build kickoff)
**Supersedes:** `2026-08-12-quorum-overhaul-program-design.md` — see
"Relationship to the superseded program" for exactly what that means.
**Review basis:** the 2026-08-17 seven-seat multi-model design panel and
smevals gap analysis (`prime-radiant-inc/smevals@0c28dc6`), both recorded in
`docs/experiments/2026-08-17-platform-direction-panel.md`; the PRI-2874
review record; and the corpus/experiment evidence cited inline.

## How to read this document

Quorum can answer one shape of question well (scenario × agent pass/fail)
and answers every other shape — harness vs harness, superpowers vs stock,
model vs model, PR vs base — with bespoke dev work per campaign. This design
turns those questions into configuration. The whole operator surface is
three commands:

```
quorum campaign register suites/harness-compare.yaml
    # expands the suite into a priced, hashed list of runs
    # → campaigns/2026-08-17-harness-compare-3f9c/campaign.json
quorum campaign run campaigns/2026-08-17-harness-compare-3f9c/
    # buys the list in contemporaneous blocks; resumable after any crash
quorum campaign report campaigns/2026-08-17-harness-compare-3f9c/
    # machine-computed comparison; SHIP/NO-SHIP only for gating campaigns
```

An **arm** names a setup, a **suite** names a question over arms,
**registration** freezes a suite into that priced list, the **dispatcher**
executes it, and the **report engine** answers the question. The release
gate stops being architecturally special: it is one saved suite with
`kind: gating`. Wall-clock and cost are platform properties, not goals: the
8-hour gate falls out of scheduling and configuration, not new
infrastructure (see Background, finding 3).

## Goal

One platform where any comparative question about superpowers is a
configuration change, runnable at any scale, with validity enforced by
schema instead of operator discipline. Motivating questions, all currently
requiring per-campaign engineering:

- Did this superpowers PR regress anything? (PR ref vs base ref)
- How does superpowers-on-claude compare to superpowers-on-codex?
- What does installing superpowers change vs the stock agent?
- Which model performs best with superpowers?

Success criteria:

1. Each question above is expressible as arm + suite documents and runs
   without writing TypeScript.
2. A gating campaign at release-gate scale (~388 samples — a sample is one
   scenario × arm × replicate slot; defined under Identity) completes,
   registration-accept to sealed report, inside 8 elapsed hours.
3. Every campaign report is machine-generated: no hand-computed statistics
   anywhere in a readout. (This retires the `bc104d0` class of failure — a
   published readout whose by-hand statistics were wrong and had to be
   retracted.)

## Background: why this replaces the 2026-08-12 program

The 08-12 program correctly diagnosed the problems (campaign-level
scheduling at 1.65× effective parallelism, quota caps that were our own
artifact, hand-read campaigns) and then prescribed a durable multi-operator
supervisor and a VM fleet. A seven-seat multi-model panel (2026-08-17,
recorded in `docs/experiments/2026-08-17-platform-direction-panel.md`)
re-examined it with adversarial briefs and converged, across all four model
families, on three findings:

1. **The validity spine is the product and stays.** Every validity mechanism
   exists because we paid for a specific failure: the 08-06 gate went GREEN
   and was discredited ($650; wrong codex model, answer-key leak, cross-run
   leak), forcing an $850 re-gate; two published readouts carried
   retractions; check holes produced false passes; a 429 latch silently
   dropped 30 cells from a battery. The lab's failure mode is never "down
   for a day" — it is "up and lying."
2. **The availability machinery was padding for this lab's shape.** Lease
   fencing, recovery epochs, boot-nonce identity, RPO=0 barriers,
   multi-operator fairness proofs, and the fleet defend against failures
   whose cheapest handling for two trusted operators is "rerun the affected
   blocks" (a block is the two-or-more-arm contemporaneous unit defined
   under Execution; worst case is one campaign, ~$850, one night — the
   08-08 gate survived a mid-battery laptop reboot on run-dir durability
   alone).
3. **The program was build-first where it should be probe-first.** Its own
   evidence implies the 8-hour gate needs scheduling and configuration, not
   a control plane: the 2026-08-12 OpenAI probe showed the observed 5-way
   concurrency ceiling was our harness's own configured limit, not provider
   throttling (zero 429s at 20-way); 10.28× parallelism was already
   achieved at `--jobs 12`; and the 08-08 gate's slowness came from running
   66 sequential lock-holding jobs, not from batch fan-out. Independent
   estimates from three panel seats: ~4.5–7 elapsed hours without any
   supervisor.

Separately, the operator-experience finding: the reason evals run only
before releases is **ceremony, not speed** — every campaign is a bespoke,
hand-authored experimental design with a scratchpad driver script. A faster
harness that still requires that authoring stays a pre-release-only tool.
The platform removes the authoring, not just the waiting.

The smevals gap analysis (2026-08-17, same experiment entry) confirmed the
standing "contracts donor, not a dependency" decision and upgraded it:
smevals' execution model (strictly serial) and data model (task × config ×
model, pooled all-time statistics) cannot carry this workload, but four of
its designs are adopted near-verbatim below (Config-as-arm, the failed-run
doctrine, immutable-run-dir storage semantics, and its check-result
extension contract).

## Design

### Concepts

**Arm** — a named YAML document describing one setup under test:

```yaml
# arms/claude-superpowers.yaml
agent: claude              # coding-agent name (coding-agents/<name>.yaml)
credential: opus_bedrock   # names a credentials.yaml entry; model rides here
superpowers: v6.1.0        # tag or SHA, or `none` for the stock agent
os: linux                  # optional; defaults per agent config
labels: {}                 # optional, free-form, reporting only
```

There is deliberately no `model:` field — see "Known coupling" below.

**Suite** — a named, reusable question over arms:

```yaml
# suites/harness-compare.yaml
scenarios: tier=sentinel        # selector or explicit list; see below
arms: [claude-superpowers, codex-superpowers]
baseline: claude-superpowers    # optional; defaults to the first-listed arm
n: 5                            # replicates per scenario per arm
kind: exploratory               # exploratory | gating
budget_usd: 150
```

A gating suite additionally carries `predicate:` and `reserve:` keys
(defined under "Report engine" and "Execution").

The v1 `scenarios:` selector is either an explicit list of scenario names
or `tier=<sentinel|full|adhoc>`, reading the tier label that scenarios
already declare and `run-all` already filters on (`readQuorumTier` in
`src/run-all/matrix.ts`). No other selector syntax exists in v1.

`kind` is the campaign's evidence class:

- `exploratory` — "what's going on?" The report is stamped DESCRIPTIVE and
  the schema has no slot for a ship/no-ship verdict, so an exploratory
  result cannot be quoted as one.
- `gating` — "do we ship?" Requires a frozen registration before any run
  starts, a registered reserve, and a machine-checkable decision
  predicate. The release gate is a gating suite.

(Naming lineage: this field was drafted as `rigor: exploratory |
confirmatory`; "rigor" and "confirmatory" were dropped as jargon
(Drew, 2026-08-17). "Gating" also aligns with the superseded program's
credential classes, gating | observational.)

**Registered campaign** — a frozen instance of a suite. **Both kinds are
registered**; registration is the same expansion for each, and only gating
suites additionally require predicate and reserve validation.
`quorum campaign register <suite>`:

- expands the selector into an explicit cell list (scenario × arm), then
  into samples (× replicate). A scenario whose `# coding-agents:`
  restriction excludes any arm's agent is **dropped for all arms** and
  listed in `campaign.json` under `excluded_cells` with the reason —
  loudly, never silently;
- resolves every ref (superpowers, evals, gauntlet) to SHAs;
- attaches per-cell duration estimates from the corpus; a cell with no
  history falls back to its scenario's median, then the corpus median, and
  is flagged `estimate_confidence: low`;
- records the baseline arm (explicit `baseline:` or first-listed);
- for gating suites, validates the decision predicate (below) and prices
  the reserve into the budget;
- hashes the canonical form. The digest is the campaign's identity; a
  changed grid is a new campaign.

Registration is the entire ceremony — no design doc, no power tables, no
scratchpad driver.

### Identity

The chain the current `MatrixEntry` lacks, as zod schemas in
`src/contracts/` (extending, not replacing, the verdict contracts):

```
campaign_id (registration digest)
  └─ block_id             the contemporaneity unit: one replicate of EVERY
     │                    arm of one cell, launched together (see Execution)
     └─ sample_id         one arm's slot within the block
          │               (scenario × arm × replicate index)
          └─ execution_attempt_id   journaled BEFORE spawn
               └─ run_id            bound when the runner emits it
```

Cardinality: every sample belongs to exactly one block; a two-arm suite's
block holds two samples, a k-arm suite's block holds k, a single-arm
suite's block holds one. Every verdict gains a campaign identity block.
Attempt identity is durably journaled before any provider spend, so no
paid work can ever be unattributable.

### Storage semantics (adopted from smevals, near-verbatim)

- Run dirs stay immutable and stay where they are (`results/`); the
  completion marker is written last.
- Anything assessment-shaped added after a run completes is append-only
  under the run dir. This leaves the offline-regrade door open without
  building regrade now.
- **Failed-run doctrine:** a typed instrument failure (staged `RunError`:
  setup, capture, infra, grader-credential) is never evidence — never
  graded, excluded from analysis n, its slot refilled by the frozen
  outcome-independent replacement rule (both kinds; see Execution).
  `indeterminate` remains distinct: it is evidence ambiguity, reported in
  full, never silently replaced. This promotes the fail-vs-indeterminate
  triage distinction from docs into schema.
- A campaign directory (`campaigns/<id>/`) holds `campaign.json`, the
  journal, and the sealed `report.json`/`report.md`, referencing runs by
  `run_id`. Nothing moves; the dashboard and the appliance archive keep
  working unchanged.

### Checks: adopting smevals' check-result extensions

`CheckRecord` keeps `{check, args, negated, passed, detail}` and gains four
optional keys from smevals' check-result contract: `score` (0–1),
`metrics` (name → number|bool), `tags` (open-vocabulary, snake_case), and
`notes`; unknown keys fold into `detail`. Verbs stay boolean for verdict
composition; metrics and tags become aggregatable by the report engine
(mean ± stderr, tag shares). This is what makes "how does superpowers
impact performance" answerable in numbers rather than pass rates alone.

### Execution

**The block is the contemporaneity unit**: one replicate of *every* arm of
one scenario cell, launched together. For a two-arm suite that is a pair;
for a k-arm suite all k arms launch side by side (so no arm needs
duplicated baseline replicates, and every pairwise comparison inside the
block is contemporaneous); for a single-arm suite the block degenerates to
one sample (no skew fields; report comparison types 2–4 only — this is the
case the future self-running sentinel suite uses). Contemporaneity is the
point: base rates drift ±25 points within hours, so only same-moment
comparisons are fair. The block is therefore also the rerun and
replacement unit. A cell with n=5 is five blocks.

- All arms of a block are admitted **atomically** — slots reserved in every
  needed quota pool, or the block waits — and launched together; the
  journal records per-arm start times against a registered
  `max_start_skew` (default tuned from Phase 0 simulation, not invented in
  this document). A skew breach does not invalidate the block in v1; it is
  recorded and rendered in the report's accounting block as a named
  validity caveat.
- Dispatch is longest-expected-first from the frozen per-cell estimates
  (sdd-*/fractals cells start at t=0, not last), greedy under per-pool caps
  plus a global slot cap, via the existing `src/scheduler/`.
- **Quota pools, v1 derivation:** a pool's identity is the credential's
  optional `quota_pool` key if set, else `base_url|api|model`. This splits
  pools per model — the old scheme keyed limits by endpoint alone, so
  distinct models sharing `api.openai.com` shared one cap of 5, discarding
  ~3× of available capacity (2026-08-12 probe) — while never merging
  distinct endpoints (`opus` direct and `opus_bedrock` remain separate
  pools). The explicit key exists for entries that genuinely share one
  provider bucket.
- A 429 puts its pool into a journaled `blocked_until` cooldown; queued
  blocks wait and resume. The terminal-skip latch (which once silently
  dropped 30 cells) is retired on this path.
- A typed instrument failure activates the **replacement rule** (both
  kinds): a fresh full block, never a single arm, never conditioned on
  outcomes. Gating suites pre-register a **reserve** — `reserve: <count>`
  spare blocks per cell, priced into the budget at registration — and
  replacement draws only from it; a cell whose reserve is exhausted
  reaches the typed terminal state `exhausted` and is named in the report
  (the predicate sees the reduced `determinate_n`, so an underpowered cell
  fails the decision rule rather than being silently absorbed).
  Exploratory suites may omit `reserve:` (default 0); their instrument
  failures then simply report as shortfall.
- **Budget is enforced at admission**: the dispatcher stops admitting new
  blocks when journaled actual spend plus the estimated cost of in-flight
  blocks would exceed `budget_usd` (which registration priced to cover
  primaries plus reserve). A budget stop is a typed terminal state,
  named at seal. Raising the budget is an operator amendment recorded
  append-only in the journal.
- Cancellation kills the process group and marks in-flight blocks aborted;
  resume reruns them whole.

**Sealing:** the completeness predicate runs over the journal — every
registered sample terminal; every primary slot included, replaced by rule,
or in a typed terminal state (`exhausted`, budget-stopped) that the report
must name; nothing pending, missing, or silently omitted — and only then is
the report generated, with `report.json` written last as the campaign's
completion marker. An unsealable campaign names exactly which samples
block it and why.

### Journal and recovery

A SQLite sidecar in the campaign directory; one dispatcher process is the
only writer; fsync per state transition; rows for block/attempt state,
attempt→run bindings, pool cooldowns, spend, and amendments.

Recovery is the entire durability story: crash → restart → reconcile
journal against run dirs on disk → keep completed blocks → rerun in-flight
blocks whole → quarantine orphaned run dirs as evidence. Host loss → new
host, rerun incomplete blocks. Worst case is a full campaign rerun (~$850
at release-gate scale, one night — the measured 08-09 cost). No leases, no
fences, no recovery epochs, no boot nonces, no outbox: the recovery unit
equals the validity unit, so exactly-once machinery buys nothing.

### Report engine

`quorum campaign report` reads the journal **plus the immutable run dirs it
references** (verdicts, check records, token/cost captures) and is
deterministic over those inputs. The v1 vocabulary is **fixed and closed**
— four comparison types, chosen because they are the ones past campaigns
actually used:

1. Pass-rate delta per (arm, baseline) pair: Fisher exact over the pooled
   2×2 counts of matched cells. Pairing here is **operational, not
   analytic**: blocks guarantee the compared runs were collected
   contemporaneously; the test itself pools counts. (Naming a matched-pairs
   test instead is a platform change, not a per-campaign choice.)
2. Token and dollar medians over matched determinate cells.
3. The accounting block: instrument errors, indeterminates, replacements,
   reserve draws, skew caveats, budget stops, and denominators — always
   rendered, never elidable.
4. Tag and metric aggregation (mean ± stderr, tag shares), descriptive
   only.

Every rendered number carries its n, denominator, measurement coverage, and
cell class. A question needing a comparison type that does not exist is a
platform PR, not a per-campaign escape hatch — escape hatches are how
hand-computed statistics come back.

**Gating campaigns** carry a `predicate:` in the suite document. The v1
predicate language is deliberately tiny: boolean combinations (`&&`, `||`,
`!`, parentheses) of atomic comparisons `<quantity> <op> <number>` with
ops `< <= > >= == !=`, over a **closed list of engine-defined quantities**:
`fisher_p(arm)`, `pass_rate(arm)`, `pass_delta(arm)` (vs baseline),
`determinate_n(arm)`, `determinate_n(arm, cell_class)`,
`instrument_error_rate`, `median_usd_delta(arm)`,
`median_tokens_delta(arm)`. Example:

```yaml
predicate: >
  fisher_p(codex-superpowers) >= 0.05 &&
  pass_delta(codex-superpowers) > -0.05 &&
  determinate_n(codex-superpowers) >= 60
```

Registration validates the predicate — unknown quantities or operators are
rejected at register time, which is the superseded spec's "no
human-judgment ship calls" made mechanical. The sealed report of a gating
campaign says SHIP or NO-SHIP because the predicate evaluated. Exploratory
reports have no predicate slot and a DESCRIPTIVE stamp in the header.
Growing the quantity list is a platform change with golden-test coverage,
not a campaign-time extension.

**Determinism bar:** byte-stable regeneration on the same host from the
same journal + run dirs (golden-oracle tests over synthetic fixtures of
both); cross-host byte-identity is deliberately not required — same data,
same decision is the bar. The Fisher implementation is cross-checked
against an independent implementation in tests (retraction insurance).
Output: `report.json` for machines, `report.md` for humans. (The dashboard
is untouched by this design; teaching it to read `report.json` is
backlog-eligible future work, not committed here.)

**Provenance in every report:** registered model (from the credential)
next to the **observed** model read back from the transcript. A mismatch is
a loud provenance failure of the affected cells, never a silent finding
about the wrong model — the 08-06 lesson, kept mechanical.

## Known coupling: model ⇔ credential (documented punt)

**What is coupled today:** a `credentials.yaml` entry binds model id,
endpoint/API dialect, auth, quota cap, and (via obol) pricing into one
name. Arms therefore select a model *indirectly* by naming a credential;
"which model is best" is arms differing only on `credential:`.

**Why this design leans on it anyway:** the credential registry is the
single authority for quota pools and pricing; an arm-level `model:`
override would bypass it and reintroduce the drift class that put the
wrong codex model into the 08-06 gate. Observed-model readback (above)
guards the residual risk.

**The cost accepted:** adding a model = adding a credential entry (a few
lines of YAML). The same model on two endpoints = two entries (this
already exists: `opus` vs `opus_bedrock`).

**The someday fix (explicitly punted, 2026-08-17, Drew):** split the
registry into endpoint/auth documents and a first-class model axis, with
quota pools keyed (endpoint org × model) and arms saying
`endpoint: + model:`. Half of this already lands with the kernel: the
per-model pool derivation above removes the *scheduling* half of the
coupling. The arm schema is versioned so `credential:` can later become
`endpoint:` + `model:` without touching any suite or campaign document.

**Revisit trigger:** the first time someone needs an arm-level model
override, or the two-entries-per-model pattern becomes a real maintenance
burden. Until then this is two lines of YAML per model.

A pointer comment at the top of `credentials.yaml` references this
section.

## Phase 0: the free capacity simulation

No live spend. A paid live capacity probe (~$850, a rented large host
rerunning the 388-sample battery) was considered and **explicitly rejected
(Drew, 2026-08-17)** — recorded here so it is not re-proposed. The corpus
already contains the answer material: the 08-08/09 gate's 388 runs with
measured durations, pool assignments, and timestamps, plus the 06-25 batch
(10.28× at `--jobs 12`).

Phase 0 is a scheduler simulation: replay the recorded durations through
the proposed dispatch policy — blocks, longest-first, per-model pool caps
at {5, 15, 20}, global jobs at {8, 12, 20, 24} — and publish predicted
makespans and per-pool critical paths per configuration, as a checked-in
experiment entry. This is the superseded spec's `quorum.capacity/v1` idea
made concrete against data we already own. It sets the `max_start_skew`
default and the target host size.

What simulation cannot prove — real high-concurrency agent traffic against
provider throttles (the 08-12 probe used short synthetic requests), host
contention at 20+ concurrent runs — is validated by **the first real
gating campaign**, which superpowers pays for when it next needs a release
gate anyway. Zero marginal spend; that campaign is itself the recorded
live evidence.

## Coexistence and sequencing

Everything lands **additively**. `run-all`, the appliance, and the
dashboard are untouched; any future decision to retire `run-all` waits
until the campaign path has demonstrably replaced its jobs, and is not
made by this document. The appliance's long-term fate (freeze-as-archive
vs upgrade) is decided after Phase 0 and the first real gate, from
measurements.

**The freeze rule survives:** evals main stays frozen during a gating
campaign — the appliance fast-forwards its checkout per job, so a
mid-campaign merge swaps the instrument. Registration already resolves
evals/gauntlet/superpowers to SHAs; the freeze becomes mechanical when the
dispatcher runs from that pinned checkout, and stays procedural until then.

**Order of operations:**

1. **Fix-now items** (independent PRs, this week, any direction):
   - Per-agent env *and filesystem* credential scoping — finding F13 of
     the 2026-08-12 adversarial review (6 of 12 launchers inherit host
     env; the Gauntlet subprocess env carries the full provider bundle;
     `env -i` alone is insufficient while the container's credential env
     file and OAuth mounts are readable under the agent's UID). Done when
     a per-agent black-box test proves the agent can reach only its own
     credential, by env *and* by filesystem.
   - The composer false-pass hole: a Gauntlet pass with zero deterministic
     post-checks composes to `pass` (`src/composer.ts`). Closed by an
     expected-check manifest per scenario used in any gating suite, plus
     planted-negative fixtures proving each deterministic check fails on
     its target defect.
   - The appliance results-import command's `--force` flag currently
     performs an unconditional recursive delete of the destination run dir
     before copying (`src/appliance/import.ts`); it loses that behavior in
     favor of reject-or-quarantine on conflict.
   - Results-volume growth: grow the volume now and add a guarded
     `prune --dry-run/--apply` that never touches runs referenced by an
     unsealed campaign (~140 dirs/day at ~199MB against ~217GB free is
     3–8 days of headroom at gate cadence).
2. **Phase 0 simulation** (~days).
3. **Kernel build** (~4–6 weeks): contracts → dispatcher + journal →
   report engine, TDD throughout.
4. **First registered gating campaign** on the kernel — the live
   validation and the first ≤8h attempt.
5. The **ranked backlog**, gated on that first ≤8h pass: smevals
   static-site export adapter (campaigns rendered into smevals' documented
   site contract — readable by non-operator stakeholders, Jesse being the
   prototype, without any quorum context; severable if smevals drifts) →
   suite registry + a self-running single-arm sentinel suite (the
   merge-time lane) → offline regrade → diff-driven scenario selection.

**Where campaigns execute:** the dispatcher is a process; it runs anywhere
quorum runs today. The gating-campaign host is chosen from Phase 0's
simulation plus the first gate's measurements.

## Testing

The repo's existing culture, no mocked-behavior tests:

- Dispatcher and journal unit-tested against the injectable clock and a
  fake runner subprocess seam.
- Crash-recovery tests: kill mid-block, restart, assert whole-block rerun
  and no double-spend in the journal.
- Golden-oracle report tests: synthetic journal + run-dir fixtures in,
  byte-stable reports out; Fisher numbers cross-checked against an
  independent implementation.
- Planted-negative fixtures for the deterministic checks of every scenario
  used in a gating suite: each check must demonstrably fail on its target
  defect.
- Schema round-trips for arm/suite/campaign/journal documents;
  `quorum check` learns to validate arm and suite files, including
  predicate validation for gating suites.
- One standing 2-scenario live exploratory campaign as the pre-gate smoke
  (trusted-maintainer only, as all live evals are).

## Non-goals

- **No supervisor, no fleet** — unless a named gate fails (the first real
  gating campaign misses 8h for control-plane reasons, or per-attempt
  credential isolation becomes a hard requirement). If that happens, the
  superseded spec's W2/W6 material is the starting point; if it does not,
  the disproof is recorded in the experiment log at equal billing.
- No multi-operator admission control: a lock file, FIFO, and two humans
  who talk. Operator identity is a recorded label, not auth.
- No dashboard changes, including reading `report.json` (backlog-eligible,
  not committed). No dashboard launch UI (standing decision, 2026-06-18).
- No retroactive migration of historical results into campaign identity;
  legacy batches remain descriptive-only, per the superseded spec's own
  non-goal.
- No regrade, export, or diff-driven selection in the first release
  (ranked backlog above).
- Live evals remain trusted-boundary; nothing here goes to public CI.
- Windows and Antigravity remain on their separate trusted-maintainer
  paths.

## Relationship to the superseded program

`2026-08-12-quorum-overhaul-program-design.md` is **superseded as the
governing plan**: its staging (Stages 1–3), five sequencing gates, four
success criteria, program-wide acceptance machinery, and the W2
supervisor / W6 fleet scope no longer direct work.

**Carried forward into this design** (the spec remains the canonical
record of their derivation and evidence): the nonstationarity/pairing
doctrine; provenance hard gates including observed-model readback; typed
outcome axes and the no-silent-skip rule; the outcome-independent
replacement doctrine (its Decision 8); quota-pool truth and per-pool
critical paths (W7); scrub-at-capture, token rotation, and
never-serve-historical-raw (W5 core — still a prerequisite for any sharing
feature); the W1 reliability items (env scoping, typed failures,
cancellable subprocess seam); the approved-credentials classification that
gating campaigns must select from (the superseded spec's "column admission
registry", its Decision 9 — gating campaigns admit key/service-credential
arms, never seat/subscription arms); and the fixture-first principle,
generalized into registration. W4 (runner/grader split, rubric-blind
driver) continues as an orthogonal instrument-quality track in Gauntlet,
unaffected by this document.

The panel's findings, the smevals gap analysis, and this supersession's
decision record are checked in at
`docs/experiments/2026-08-17-platform-direction-panel.md`; the experiment
log receives the Phase 0 simulation entry when it runs.
