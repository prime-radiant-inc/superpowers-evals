# 2026-08-17 — Platform direction panel + smevals gap analysis

Research campaign, not a live-eval campaign: a seven-seat multi-model
design panel re-examined the approved PRI-2874 program
(`docs/superpowers/specs/2026-08-12-quorum-overhaul-program-design.md`,
then at `cb9fd8c`) against Drew's challenge that it was too conservative
and possibly aimed wrong. Outcome: the program was superseded by
`docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md`.
This entry is the durable record of the panel, the smevals analysis, and
the decisions — including the rejected spend.

## Panel setup

Seven read-only staff-level seats, four model families, deliberately
adversarial lens allocation, all working from repo evidence with file:line
citation requirements (Paseo workspace "evals-overhaul research panel"):

| Seat | Model | Brief |
|---|---|---|
| Fable A | claude-fable-5 (xhigh) | Mechanism-by-mechanism conservatism audit of the spec |
| Fable B | claude-fable-5 (xhigh) | Ground-truth "why is it slow/cumbersome": ranked levers with arithmetic |
| Sol A | gpt-5.6-sol (max) | Aggressive re-plan to the 8h gate with availability constraint dropped |
| Sol B | gpt-5.6-sol (max) | Red team: genuine irreversibles vs availability theater |
| K3 A | kimi-k3 (max) | First-principles redesign ignoring the spec's staging |
| K3 B | kimi-k3 (max) | Devil's advocate FOR the current program, with mandatory concessions |
| GLM | glm-5.3 (high) | Fresh eyes, forbidden from reading the spec until the end |

Plus an episodic-memory context-recovery agent and (next day) an smevals
deep-read agent (`prime-radiant-inc/smevals@0c28dc6`, clone + full read).

## Convergent findings (all four model families, no coordination)

1. **Validity spine = the product; keep.** Receipts: the 08-06 gate went
   GREEN and was discredited ($650; wrong codex model, answer-key leak,
   cross-run leak) forcing the $850.40 re-gate (~$1,500 + 2.5 days for one
   release decision); statistics retraction `bc104d0`; luna normalizer
   CORRECTION; three verified false-pass check holes; 30 cells silently
   dropped by the 429 latch; billing exhaustion masquerading as grader
   verdicts. "The lab's failure mode is never down-for-a-day; it is up and
   lying" (K3 B).
2. **~1/3–1/2 of the program mass was padding for a 2-trusted-operator
   lab:** W6 fleet + criteria 3/4, W2's distributed-durability tier
   (recovery epochs, boot-nonce identity, RPO=0 fsync barriers,
   lease/no-billing fencing — a partitioned-worker threat model that
   cannot exist when supervisor and executor share one kernel), the
   multi-operator fairness/identity/idempotency layer, W4's 85-story
   migration ahead of its justifying canary, W5's publication suite beyond
   scrubbing. Replacement converged on independently by four seats:
   fail-closed abort + whole-block rerun (worst case ≈ one campaign,
   ~$850 — the 08-08 gate survived a mid-battery laptop reboot on run-dir
   durability alone).
3. **Build-first where it should be probe-first.** The 08-08 gate's 31h
   came from 66 sequential lock-holding jobs with drain barriers (run-all
   has no replicate support and cross-products cells); the scheduler
   itself was already sufficient; cap-5 was harness-only (2026-08-12
   probe); 10.28× fan-out already achieved at `--jobs 12`. Three seats
   independently estimated the 388-sample gate at ~4.5–7h with no
   supervisor. The spec grew by review accretion: seven rounds each added
   mechanism, none removed any (the Linear ticket's original criteria 2–3
   were "nice-to-have" before hardening).
4. **Drew's premise, corrected rather than confirmed.** "Only used
   pre-release" is empirically false (~13 gated decisions in 11 weeks,
   ~$2,100–2,300 priced gating spend, appliance corpus 3,601 verdicts,
   lock-time trending up). "Broken for a day is fine" holds for
   availability machinery but fails mid-campaign: the appliance
   fast-forwards its evals checkout per job, so a merge into broken main
   swaps the instrument. "Jesse runs it locally" is a development
   workflow, not a gate-evidence path (332/626 laptop runs null
   provenance; a laptop rescore superseded as contaminated; break-glass
   procedurally barred during cutover).
5. **Ceremony, not speed, causes release-only usage** (GLM): every
   campaign is a bespoke clinical-trial-grade design doc + scratchpad
   driver; the program made the ceremony faster without making it
   unnecessary. This finding became the platform framing of the successor
   spec.

## Standalone fix-now findings (any direction)

- F13 credential leak verified in current source: 6/12 launchers inherit
  host env; Gauntlet subprocess env carries the full provider bundle;
  container credential env + OAuth mounts readable under the agent UID —
  `env -i` alone insufficient (Sol B).
- Composer false-pass hole: Gauntlet pass + zero deterministic post-checks
  composes to `pass` (`src/composer.ts`); fix = expected-check manifest +
  planted-negative fixtures (Sol B; not present in the 08-12 spec).
- `import --force` unconditionally recursively deletes the destination run
  dir (`src/appliance/import.ts`) — can destroy sealed contemporaneous
  evidence, which nonstationarity makes unrecreatable.
- Disk: 3–8 days of headroom at gate cadence.

## smevals gap analysis (2026-08-17)

smevals = ~1.9k-LOC Python engine (simonw, July burst; 88 real tests;
PyPI; experimental; strictly serial; Jesse's unmerged `wip/studio` branch
is a +24.7k-line platform-shaped fork). Verdict: **emulate the shape, do
not build on it** — its execution model (serial) and data model
(task × config × model, pooled all-time statistics that violate the
nonstationarity doctrine) cannot carry this workload. Adopted
near-verbatim into the successor spec: Config-as-first-class-arm, the
failed-run doctrine, immutable-run-dir/write-last/append-only-grades
storage semantics, the score/metrics/tags/notes check-result extension.
A one-way export adapter to smevals' static-site contract went on the
backlog (Jesse-legibility).

## Decisions (Drew, 2026-08-17)

- Goal reframed: an eval **platform** — any comparative question as
  arm+suite configuration; release gate = one saved gating suite.
- Approach chosen: **platform kernel** (new `quorum campaign` dispatcher +
  journal + report engine, additive beside run-all) over manifest-retrofit
  and full-platform-first alternatives.
- **Rejected spend:** the panel's proposed ~$850 live capacity probe
  (rent big host, rerun the 388 battery). Replaced by a free scheduler
  simulation over the recorded 08-08/09 durations; live validation folds
  into the first real gating campaign. Recorded so it is not re-proposed.
- `rigor:` renamed to `kind: exploratory | gating`; "confirmatory" dropped
  as jargon.
- Model stays bound to credentials (documented punt with revisit triggers
  in the successor spec; pointer comment added to `credentials.yaml`).
- 08-12 program spec marked SUPERSEDED (validity doctrine carried forward;
  staging/supervisor/fleet scope not).

## Negative results, equal billing

- The staged supervisor program's central premise (criterion 1 requires a
  durable control plane) is contradicted by its own cited evidence; the
  Phase 0 simulation and first kernel gate will confirm or refute at zero
  marginal spend. If the kernel gate fails for control-plane reasons, the
  W2/W6 material is the recorded starting point — this entry is not a
  verdict that the supervisor was wrong, only that it was unproven.
- K3 B's steelman survived on one core point the successor spec adopts
  wholesale: invalid gates double cost rather than halving it; the
  validity spine is untouchable.

Full seat reports live in the 2026-08-17 session records (Paseo workspace
"evals-overhaul research panel" + session memory); this entry is the
durable summary.
