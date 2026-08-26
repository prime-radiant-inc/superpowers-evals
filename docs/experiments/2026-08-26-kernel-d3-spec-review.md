# Kernel D3 spec review — revision 1 (2026-08-26)

**Subject:** `docs/superpowers/specs/2026-08-26-kernel-d3-campaign-engine-design.md`
(revision 1, drafted by qwen3.8-max-preview agent `d69783ad` from the mined
skeleton + the approaches-gate adjudications).
**Gate pattern:** two independent seats, split hunting grounds, family rules
held (qwen drafted; openai + anthropic reviewed). Orchestrator verified the
load-bearing claims directly against main before adjudicating.
**Seats:**
- **sol** (`gpt-5.6-sol`, fast mode, max thinking; agent `c9d77494`) —
  composition with shipped D1/D2 contracts, task coverage, exit criteria.
  Verdict: **NOT-READY** (9 Critical, 10 Important/Minor, 8 pre-build
  questions).
- **fable** (`claude-fable-5`, xhigh; agent `76ff18ca`) — internal coherence,
  failure-semantics realism, contention guard end-to-end, scope discipline.
  Verdict: **READY-WITH-FIXES** (2 Critical, 14 Important, 10 Minor).

**Adjudicated verdict: NOT-READY → revision 2 required.** Sol's stricter
verdict stands: three finding classes are contract-blocking and were
independently re-verified by the orchestrator against main. Both seats'
findings substantially converge underneath the different labels; the union is
below, deduplicated, with dispositions.

## Orchestrator verification record

Claims re-verified directly against main before adjudication (not taken on
seat authority):

1. **Layout/reconstruction break — CONFIRMED.** Draft Decision D-6 puts the
   snapshot under `<campaignDir>/snapshot/` but superpowers worktrees at the
   campaign-dir root. Shipped `reconstructSnapshot(destDir)` derives
   `evals/`, `gauntlet/`, `bin/gauntlet`, the completion marker, **and** the
   `superpowers-<sha>` enumeration all from ONE `destDir`
   (`src/campaign/instrument-snapshot.ts:57,250-274`). Under the draft
   layout, reconstruction from `snapshot/` silently returns zero superpowers
   worktrees, so `verifySnapshot` never guards the treatment trees on
   resume; reconstruction from the campaign dir fails the completion
   contract. The draft's own citation ("D2 pins destParent/destDir = the
   campaign dir") contradicts its `snapshot/` invention.
2. **Reconstruction self-verification — CONFIRMED.** `reconstructSnapshot`
   re-reads expected SHAs from current worktree HEADs
   (`instrument-snapshot.ts:263,271-272`); a moved HEAD then verifies
   against itself unless the caller cross-checks against `Campaign.refs`.
   The cross-check is nowhere in the draft.
3. **Rerun lifecycle hole — CONFIRMED, broader than either seat stated.**
   `applySampleEvent` (`src/contracts/campaign/state-machine.ts`) has no
   legal continuation for any post-`run_allocated` rerun: no edge from
   `spawned`/`exposed` back to a re-attemptable state; `attempt_created`
   applies only from `admitted`; every terminal is a dead end. Meanwhile
   `crash-windows.ts` pins `kill_pgid_rerun_block` as a required resolution
   — shipped D1 names a recovery its own state machine cannot journal. The
   pre-spawn path (`void_attempt_readmit`) IS expressible (binding-only
   `attempt_created` from `admitted`); only post-spawn rerun is not.
4. **Seal-predicate blindness to fresh instances — CONFIRMED.**
   `sealPredicateHolds` iterates only frozen-universe samples
   (`crash-windows.ts:152-170`); replacement blocks minting fresh ids are
   invisible to sealing (seal can race a live replacement), and the
   conservation rule ("one included outcome per primary slot") is unprovable
   over ids the universe doesn't know. `CampaignSchema` freezes
   blocks/samples with every-sample-in-exactly-one-block integrity and has
   no reserve-slot representation.
5. **Vocabulary checks — CONFIRMED.** 20 events, no quarantine carrier;
   `sample_disposition` admits only `included | excluded_block_replaced`;
   `block_replaced.cause` is `z.enum(INSTRUMENT_CAUSES)` (abort/drift
   re-entry inexpressible); `run_allocated.key_env` is singular, optional,
   untagged (cannot reconstruct subject + grader grants); `budget_stopped`
   is terminal with no resurrection edge.
6. **Orchestrator's own catch (add to revision 2):** the campaign reducer
   rejects sample-scoped events and vice versa BY DESIGN ("callers fan them
   out"), while draft R-JRN-7 reads any replay `reject` as a loud
   journal-corruption finding. The event→machine replay routing must be
   pinned or canonical streams will spuriously "corrupt."

## Blockers to revision 2

### A. Proposed D1 erratum bundle (draft as **E7** in the spec's Errata; ratification at the revision-2 gate, E1–E6 precedent)

The "zero journal vocabulary amendments" claims must be **scoped to what the
gate adjudicated** (key-wait, contention) — not stated as a global D3
property (fable C-1's framing). E7 covers, precisely and together:

1. **Rerun/replacement lifecycle:** journal-expressible whole-block rerun
   post-`run_allocated` (verification item 3), covering crash rerun,
   aborted-block re-entry (SIGINT/resume + drift kill — **reserve- and
   count-neutral**, fable I-9), instrument replacement (reserve draw), and
   the post-budget-stop replacement terminal (fable I-8: pin
   `budget_stopped` from `planned` + shortfall at seal).
2. **Replacement/rerun reasons:** widen `block_replaced` beyond
   `InstrumentCause` (block-scoped reasons) or add a distinct replan event.
3. **Seal completeness over rerun/replacement instances** (verification
   item 4): the predicate must cover activated instances; unactivated
   reserve semantics pinned.
4. **Quarantine carrier:** binding-only `quarantined` event (E5 pattern) —
   fable C-1 ≡ sol.
5. **Role-tagged key grants:** `key_grants: [{role, env}]`-shaped payload
   (or equivalent) so subject + grader grants both reconstruct (sol #4b).
6. **Pin (no vocabulary change):** a budget raise never resurrects
   `budget_stopped` samples; it only prevents future stops (sol Q3).
7. `budget_event` identity (sol #10): if per-sample spend attribution is
   needed, an additive optional field joins E7; otherwise pin aggregate
   semantics + seal-time derivation explicitly.

### B. Layout + reconstruction (verification items 1–2)

- Decision D-6: **destDir = the campaign dir itself** — drop `snapshot/`.
  Layout: `<campaignDir>/{campaign.json, lock, journal.db,
  contention-telemetry.jsonl, cancel-request, .storage-paused, evals/,
  gauntlet/, bin/gauntlet, .quorum-snapshot-ok, superpowers-<sha>/}`.
  Exactly what shipped `reconstructSnapshot`/`verifySnapshot` and the D2
  spec pin. Update R-DSP-12 and R-RCV-6; document marker, SQLite WAL/SHM,
  and lock-metadata entries in the layout (sol #20).
- R-RCV-6: after reconstruction, resume **cross-checks handle SHAs against
  `Campaign.refs`** (evals, gauntlet, superpowers_by_arm); mismatch refuses
  loudly. Expected identity never derives from current HEAD alone.
- Reconcile SHA-length contracts: D1 pins 40-hex; D2 accepts 40/64. Pin 40
  at the campaign layer; note D2's 64 as dormant.

### C. Execution authority + identity intake

- **Snapshot-first registration** (sol #3): resolve refs → materialize the
  evals+gauntlet snapshot → registration reads scenarios, agent YAML, and
  `credentials.yaml` **from the snapshot's evals tree**; `campaign.json`
  stores the resolved grid plus scrubbed (secret-free) arm/credential
  execution surface; resume authority = `campaign.json` + snapshot. Task
  order updated accordingly (snapshot integration before registration).
- **Identity intake is a named third threading surface** (fable C-2 ≡ sol
  #4a): campaign-identity argv → `RunScenarioArgs` → **persisted at run-dir
  allocation** (this is what makes R-RCV-3's attempt-id-mismatch quarantine
  possible at all) → stamped on every verdict/error/stopped path. Amend
  scope item 9, artifact layout, task list, and the code-reality section
  (state that the intake is new work; the `run_allocated:` protocol line
  already exists at `run-command.ts:73`).
- **Child-contract compatibility at registration** (fable I-12): probe the
  snapshot CLI for the child contract (or pin a minimum evals commit);
  reject incompatible evals refs loudly.

### D. Locks / recovery / cancellation protocol

- **Pin the live-spend-lock FD owner** (sol #8a, fable M-2): dispatcher
  only; the FD is never inherited (CLOEXEC); children are covered by the
  holder's accounting and marked via an explicit channel (env/argv), never
  acquiring. Rewrite "children inherit ownership" accordingly.
- **Recovery ordering** (sol #8c): acquire lock → kill/reconcile →
  resource-floor preflight → admit. Preflight failure refuses admission,
  never blocks cleanup of orphan spenders.
- **Stale-lock reclamation** without unlink-a-locked-path races: reuse the
  D2 provisioning lock idioms (ownership tokens, rename-then-delete); never
  reclaim by unlinking in place (sol #8b).
- **pgid identity guard** (fable I-13 ≡ sol): kill only pgids of attempts
  without a journaled terminal; existence + command-line sanity check before
  signaling; record reclaimed-without-kill. Same pid-reuse caveat on lock
  reclamation and cancel signaling.
- **Cancellation, one pinned order for both paths** (sol #8d, fable I-10):
  marker → stop admission → kill + verify dead → journal `aborted` per
  in-flight block → `campaign_cancelled` **last**. Post-crash cancel also
  journals `aborted` (I-10a). Resume checks `cancel-request` first and
  completes cancellation instead of resuming (I-10b). Signal = SIGTERM
  (I-10c). Note the sample machine admits `aborted` regardless of campaign
  state, so replay is legal either way — the order is pinned for
  crash-consistency, and relied upon.
- **Mechanism feasibility pinned** (sol #18 slice): `flock(1)`/`setsid(1)`
  do not exist as utilities on the Darwin dev host; "POSIX built-ins" is
  not an implementation. Pin verified mechanisms — candidates to verify:
  SQLite `BEGIN EXCLUSIVE` on `journal.db` as writer election
  (crash-released, portable, zero deps); D2's lock-dir protocol for the
  host-wide lock; `node:child_process` `detached: true` (setsid semantics)
  under Bun for process-group spawn. The drafter must verify the chosen
  mechanisms against Bun reality, not assert them. Split portable hermetic
  tests from Linux-gated integration tests.

### E. ENOSPC fail-stop rewrite (Decision D-13)

The draft's children-keep-running pause cannot preserve durable truth
(sol #9) and lets spend continue unrecorded, violating the journaled-spend
budget invariant; the children's own evidence shares the full volume and is
doomed anyway. Rewrite: halt admission → kill campaign children → durable
marker (reserve control-plane headroom at campaign open so the marker can
land) → resume reconciliation. Include fable I-1's per-event-class fate
table (admission-section events roll back; post-fact events buffer + retry
with original `ts_ms`), the terminal-evidence-without-journal
reconciliation rule, and retroactive `storage_paused` ordering before the
first buffered activity event (fable M-6).

## Important bundle (revision-2 text; no ratification needed)

- **Release timing** (sol #5): slots release at **service end** (child
  death), not analytical terminal; retained-evidence exclusions
  (`skew_excluded`, `excluded_block_replaced`) hold subject/global slots
  until process exit, grader slots until grader completion. This clarifies
  D-1's transcription ("its own terminal") to P0's ratified occupancy model
  — it does not re-open the adjudication.
- **Drift affected-set** (sol #6): affected = every block in flight at any
  point during [last clean verify, re-materialization complete] + admitted-
  but-unspawned. The draft's "spawned after the last clean verify" misses
  long blocks spawned earlier that consume drifted content mid-run and can
  terminal-verify clean after re-materialization. Kill all affected. Define
  the **authorized repair operation** (D2 materializers refuse dirty/
  wrong-HEAD trees by design — removal + re-create under lock, loud); pin
  pre-seal-drift handling for D4 (fable M-5: caveat + refuse-to-seal
  pending operator ack).
- **Contention guard hardening** (fable I-2/I-3/I-4/I-5, sol #16/#19,
  M-8): sidecar **coverage predicate** handed to D4 — sidecar must cover
  [campaign_opened, last sample terminal] within N× cadence; uncovered
  windows adjudicate overlapping blocks *unknown*, never clean (fail-closed;
  torn tail = truncate + loud note). Freeze `cadence_ms` + `sustain_k` into
  the registered `contention` block (digest members) and pin breach-window
  edge semantics identically for runtime and seal. Dead-sampler liveness:
  admission wave checks sidecar last-sample age; staleness > 2× cadence
  halts admission. Fingerprint match policy: exact on cpu_model/cores,
  registered tolerance bands on mem/disk; honest forfeiture text (v1 host
  migration = new full campaign, completed evidence forfeited — no
  cross-campaign adoption contract; sol #19). Metric sources, absolute
  floors alongside relative thresholds, entry/exit hysteresis, missing-
  sample policy pinned.
- **D4 writer surface** (sol #7c, fable M-10): R-JRN-3 rephrased —
  status/report *readers* never write; the **sealer is a writer** acquiring
  the flock through an explicit journal writer API for `adjudication`/
  `sealed`. Reconcile with `state-machine.ts`'s "D3 sealer" comment in the
  PRI-2874 seam-map erratum note.
- **Accepted-cost note** (records sol #7 without re-opening the gate):
  seal-time contention invalidation means invalidated blocks are shortfall,
  not refilled — dispatch is over by then. Named in the spec; reserve
  guidance sized accordingly.
- **Journal precision** (sol #10, house-style level, not full DDL):
  per-table columns/uniqueness, the one-transaction append (event +
  projection updates atomic), PRAGMAs on every writer connection, busy
  behavior, `readEvents(afterSeq)` cursor exclusivity, WAL/checkpoint rules,
  directory fsync. Publish-then-journal crash window closed (fable M-1 ≡
  sol): stage the initialized campaign dir including journal +
  `campaign_opened`, rename once — or pin idempotent journal completion at
  open and forbid re-journaling `campaign_opened` on idempotent
  re-registration. **Pin the replay event→machine routing table**
  (orchestrator catch, verification item 6).
- **Emitters** (fable I-6): child exit + verdict read → dispatcher journals
  `run_completed`; classifier `instrument` verdict → `instrument_failure`;
  both in the dispatcher's writer session.
- **Exposure** (sol #11 ≡ fable I-11): per-harness `ExposureProbe` contract
  (tail-safe semantics, truncation/rotation/rewrite behavior, monotonic
  single emission); decision point pinned at block terminal;
  capture-derived value permitted when runtime observation absent but the
  final log yields it by decision time; audit divergence that changes
  inclusion invalidates the block; per-harness mid-run observability on the
  qualification checklist. Trim the dead source-(1) fixtures to a
  precedence hook (fable M-9, YAGNI).
- **429 registry precision** (sol #12): anchored structured matchers with
  provider/API predicate, evidence source, subject/grader role attribution,
  retry parsing + units + clamps, per-family default/max cooldown, typed
  cause; false-positive fixtures including model-authored 429 text.
- **Classifier input** (sol #13): exhaustive `ClassificationInput` →
  `{class, cause?}` table over verdict/outcome × stage × exit/signal × role
  × sensor evidence; any needed `InstrumentCause` additions join E7;
  unknown combinations stay `evidence`/indeterminate.
- **Grader pricing restriction** (sol #14): v1 requires the registered
  grader to match the estimates artifact's grader (reject otherwise, or
  explicit token-volume-based override); surcharge formula defined and
  versioned.
- **Registration determinism** (sol #15, fable M-4): deterministic
  comparison/cell/sample/block ID algorithms, canonical expansion/sort
  order, typed `RegisterArgs`/`RegisterResult`, CLI option/default table,
  noninteractive confirmation behavior, collision handling; block dispatch
  priority = **max** expected duration across its samples.
- **Resume preflight additions** (fable I-14): key-env presence (arms +
  grader) at every lock acquisition; N-consecutive-spawn-failure pool halt
  (admission-halt semantics) so a lost env can't burn the reserve.
- **Exit criteria** (sol #18): three separate live campaigns (completion /
  crash-resume / cancel-and-refuse-resume) — the single combined lifecycle
  is impossible; Linux-gated integration matrix (real two-process locking,
  detached-group TERM→KILL, pid-reuse defense, kill-9 SQLite reopen,
  SQLITE_FULL, partial sidecar, exposure races, D2 reconstruction drift,
  direct `run`/`run-all` lock integration) split from portable hermetic
  tests; Clock seam named uniformly (journal ts, registration, cancellation,
  cooldown, recovery).
- **Task decomposition rebuilt** (sol #17 ≡ fable I-7), converged order:
  (1) E7 + contract additions + typed seams, (2) locks + host probe,
  (3) journal + atomic publication, (4) snapshot integration/reconstruction
  + refs cross-check, (5) registration from the snapshot, (6) spawn/
  identity/grants, (7) sensors + contention + classifier, (8) dispatcher,
  (9) recovery + cancellation + CLI threading + D4 handoff. Fable I-7's
  split honored: materializer call-site wiring stays early (task 4); the
  halt/kill/replacement mapping lands with the dispatcher (task 8).
- **Minors:** digest-prefix collision handling (full digest or verified
  expansion); `ts` vs `ts_ms` normalization; sidecar "journal-referenced"
  wording fixed (nothing references it today); host-wide lock path is
  user-wide — pin an appliance-owned shared path for production, env
  override for tests (sol #22); grader cap ≥15 becomes a registration
  warning (fable M-3); `estimate_inflight` retirement via spend
  supersession in the materialized `spend` table (M-7); halt/resume
  one-line state banner from `campaign run` (M-9); marker vocabulary noted
  initial.

## Rejected / disposed with reasons

- **Sol #7's pre-seal invalidation phase with reserve refill:** conflicts
  with the gate-adjudicated D-3/D-5 shape (seal-time invalidation via
  `adjudication`, admission-only halt). Adopted instead: coverage predicate
  + frozen K/cadence + the accepted-cost note. Re-opening OQ-11's timing is
  a user decision, flagged upward, not taken here.
- **Sol #10's normative SQL DDL walls:** pinned to the D-7 precision level
  (columns, uniqueness, transaction shape, PRAGMAs, cursor semantics);
  index tuning stays implementation-owned under the replay-determinism
  byte-agreement tests. House style.
- **Fable's READY-WITH-FIXES verdict:** superseded — the rerun-lifecycle
  hole (which that seat did not surface) is contract-blocking on its own.

## Process next steps

1. Revision 2 drafted by the original drafter agent (context intact) from
   this record's Blockers A–E + Important bundle.
2. Scoped re-review by the same two seats (delta review against this
   record's dispositions).
3. Ratification with Drew: the E7 erratum bundle, the ENOSPC fail-stop
   override of the draft's children-keep-running choice, and (if he wants
   to re-open it) contention invalidation timing.
4. Then `writing-plans` → plan review → SDD execution, per the D1/D2 arc.

---

# Revision-2 delta review (2026-08-26, second round)

**Seats (fresh agents, same families):** sol (`gpt-5.6-sol`, fast mode,
max; agent `8b07d634`) — E7 ratifiability + mechanism claims + per-item
audit; fable (`claude-fable-5`, xhigh; agent `e0fe3948`) — failure
semantics of the rewritten text + coherence + per-item audit.

**Both verdicts: NOT-READY — do not ratify E7 as drafted.** Convergent
audits: of the first round's dispositions, sol scores 8 landed / 13
partial / 0 missed on its 22; fable scores 24 landed / 2 with-gaps / 0
missed on its 26. Revision 2 held its ground everywhere the record asked;
the blockers are defects **introduced or left latent in the new text**,
concentrated in E7's lifecycle core and the Blocker-D mechanism rewrite.
Scope discipline verified clean by both seats (nothing added beyond the
record; drafted defaults all flagged). Orchestrator verified the three
highest-scope claims directly: the writer-election lapse (spec :659-679 —
per-event commits release the `BEGIN IMMEDIATE` lock between events; sol
reproduced live), the staged-publication/snapshot conflict (D2's wrapper
embeds the absolute `gauntletRoot` and `assertSnapshotComplete`
byte-compares at the final path — `instrument-snapshot.ts:126-130,166-172`
— so renaming a staged dir breaks the completion contract), and the
`aborted` fan-out reject on a completed sibling arm (shipped
`applySampleEvent` has no LATE branch for `aborted`; a partial-block abort
is canonical in D1's own design).

## Rev-3 patch list (all adopted; none rejected this round)

**P-1 — E7 lifecycle core rewritten around instance-scoped state**
(sol C1+C2+C3 ≡ fable C-N1, + fable I-N2/I-N3/M-N5, sol I8):
- Successor **membership carrier**: the replacement/rerun instance's
  `sample_ids` (and for replacements: arm mapping / slot identity /
  reserve activation) ride `block_replaced` or the successor's
  `block_admitted`; replay derives membership from events, never from
  out-of-band state. Frozen primary/reserve slot representation pinned
  (CampaignSchema additive amendment, joins the contract-additions list).
- **Fan-out rule**: block-scoped events skip already-terminal samples as
  `ignore-late` (an E7 transition-table change — shipped `aborted` REJECTs
  from `completed`), so partial-block aborts replay canonically; routing
  table fan-out defined over universe-plus-instance-chains.
- **Partial-predecessor entry**: define how every sample of a partially
  terminal predecessor enters the successor (incl. the completed arm —
  `excluded_block_replaced` with `superseded_by` into the successor's
  roster).
- **Seal obligation begins at mint**: a successor is a pending seal
  obligation from `block_replaced` (not from admission); it stays pending
  until terminal or an explicit block/cell-scoped replacement-impossible
  resolution (carrier for the zero-witness budget-suppressed case pinned —
  fable I-N2). Unactivated reserve distinguished from required samples via
  the frozen slot representation.
- **Reason set completed**: add the validity-replacement reasons this
  spec itself requires — runtime skew refill and exposure-audit
  invalidation (sol C1b ≡ fable I-N3).
- **`superseded_by` invariants**: uniqueness, acyclicity, one-to-one,
  same-cell/same-arm preservation, termination rule incl. chains ending in
  typed cell terminals (fable M-N5).
- **E7.5/E7.7 tightened** (sol I8): `key_grants` role-uniqueness +
  cardinality + mutual-exclusion with legacy `key_env`; `budget_event`
  netting semantics made deterministic (identity or absolute-total rule)
  and reconciled with R-JRN-12; legacy `cause` → `{reason, kind}`
  round-trip rule.

**P-2 — Writer election gets a session-scoped mechanism** (sol C5 ≡ fable
C-N2): `BEGIN IMMEDIATE` demoted to per-append atomicity (what it
provides). Election/fencing candidates handed to the drafter, verify
before pinning: session lease via the D2 lock-dir idiom beside
`journal.db` (heartbeat + birth identity per P-3) **plus in-transaction
fencing** — a `meta` writer-generation row bumped at election and checked
inside every append transaction, so a deposed-but-alive writer fails its
next append loudly. D4 sealer takes the same lease. Mechanism-verification
section slimmed to what remains load-bearing; claims sol could not
reproduce from checked-in evidence (GC-finalizer experiment, kill-9 WAL
result, grandchild membership, O_CLOEXEC) marked asserted-not-proven and
routed to the Linux matrix.

**P-3 — Long-lived lock staleness** (sol C6 ≡ fable I-N5): mtime-only
staleness forbidden for the live-spend lock and the journal lease.
Reclamation requires stale-heartbeat AND dead-holder (pid + birth
identity); holders heartbeat; a merely-old token is never reclaimed.
Contention refusal names the live holder.

**P-4 — Publication un-collides with the snapshot** (sol C4): whole-dir
staging is out — it relocates a non-relocatable snapshot (absolute wrapper
path; git-worktree registrations don't survive moves). Rev 3 takes the
record's other M-1 option: materialize snapshot trees at the **final**
campaign-dir path (D2 materializers are idempotent at fixed dest, their
re-entry contract covers crash debris), then journal init, then
`campaign.json` staged + renamed **last** as the readiness marker
(restoring R-REG-5's original "publication atomic last"). A dir without
`campaign.json` is an incomplete registration; idempotent re-entry
completes or reuses it; `campaign_opened` never re-journaled.

**P-5 — ENOSPC reservation made real** (sol C7, fable M-N1/M-N2): a
preflight floor is not a reservation. Pin a reclaimable control-plane
reserve (e.g. a ballast file created at campaign open, released on
ENOSPC to land the marker, the journal tail, and cancellation evidence —
candidate, verify) or state the honest limits. Fix the D-13 step-order
contradiction (best-effort `storage_paused` "before the kill" vs step
order); pin sidecar-append ENOSPC detection (the sampler plausibly hits
the full volume first). Complete the fate table over the vocabulary
(fable I-N1): `budget_event` spend for children that terminaled during
the pause buffers with `run_completed`; block-terminal decisions and
`pool_blocked` racing the kill assigned fates; killed-mid-run partial run
dirs get `aborted` journaled at resume (E7 rerun entry requires it).

**P-6 — Contention breach edges made symmetric and complete** (fable
I-N4): entry and exit both K-sustained (or an explicit asymmetric choice),
the per-threshold `hysteresis_ms` either used or removed, semantics pinned
identically for runtime and seal.

**P-7 — Owed literals delivered** (sol I10/I11/I12 — completions of
already-adopted round-1 items, not new scope): the 429 registry's actual
anchored rows + per-family default/max cooldowns + precedence/duplicate
arbitration; the classifier's exhaustive mapping rows + the final
`InstrumentCause` additions (pinned in the spec so task 1 can add the
vocabulary before task 7 builds the classifier); literal ID-derivation
algorithms (encoding, hashing, collision behavior) + the promised CLI
option/default table. Plus schema homes (sol I9): the scrubbed execution
surface, `surcharge_formula_version`, and a grader-capable pricing
override join the contract-additions list as additive D1-schema
amendments. Minors: D-11's "operator log" phantom artifact named to the
real carrier (fable M-N3); repair-op composition with D2's re-entry
contract stated (M-N4); the appliance-runbook citation corrected — the
production live-spend-lock path is pinned here and the runbook update is
an implementation obligation (sol M13).

## Process

Revision 3 by the same drafter from this patch list, then a **narrow
verify pass** scoped to P-1…P-7 only, then the ratification package to
Drew (E7 as revised, ENOSPC fail-stop, optional OQ-11 timing re-open).

---

# Revision-3 verify round (2026-08-26, third round)

**Seats (fresh agents):** sol (`8b07d634`→verify agent `e8374f1c`, fast
mode, max) — **NOT-READY** (2 Critical, 8 Important, 1 Minor); fable
(verify agent `689bfb2e`, xhigh) — **READY-WITH-FIXES** (3 Important,
7 Minor, walked all five 2am scenarios: four converge). **Adjudicated:
the substance converged** — P-2 and P-6 clean by both seats; the E7
rebuild's shape is right (roster-on-mint endorsed by both); what remains
is one fully-enumerable surgical pass, no design freedom left. Sol's two
Criticals and fable's F1/F2 are the same two defects at different
severity labels (both seats independently found the routing-row defect;
the mint-window findings are facets of one underdetermined window).

**Seat conflict resolved by merger (netting):** sol's double-count
objection (est=10, spend=9 → position 19 until next snapshot) is real;
fable's endorsement of absolute-total (self-healing, errs conservative,
zero vocabulary cost) is also right. Disposition: absolute-total stands
WITH sol's atomicity pin — any spend journaling or in-flight membership
change journals its superseding `estimate_inflight` snapshot in the same
critical section, zeroing the double-count window in the journal.

## Round-4 fix list (final surgical pass; all items have pinned fixes)

- **S-1** `block_replaced` gets its own replay route: instance-chain +
  roster projection only, never the per-sample reducer (which REJECTs it —
  both seats probed). [sol C1 ≡ fable F2]
- **S-2** Mint-window semantics pinned: (a) mint + predecessor roster
  dispositions in one dispatch critical section (order pinned); (b) a
  predecessor named by `block_replaced` is **superseded, never rerun** —
  R-RCV-2/R-RCV-5 resolver override; resume completes missing dispositions
  from the mint roster; (c) successor obligations are successor-local —
  rerun successors (shared sample ids) need post-mint terminal witnesses,
  predecessor-era terminals never satisfy them; (d) seal clause 1 scoped
  to primaries + activated reserves. [sol C2 ≡ fable F1]
- **S-3** `excluded_block_replaced` disposition source gains `admitted`
  (shipped edge is spawned|exposed|completed; an admitted-not-yet-spawned
  sibling is reachable at first-failure time). [sol I1]
- **S-4** E7.3a enforcement locations: structural invariants at replay;
  cell/arm checks against the frozen Campaign; termination only at seal
  (live successors legitimately dangle); roster `supersedes` ↔ disposition
  `superseded_by` correspondence canonical. [sol I2]
- **S-5** E7.5 grants presence matrix made total: legacy rows neither
  field; new rows `key_grants` required / `key_env` forbidden; per-role
  presence rule derived from D1 Decision D-1 and pinned; ≤1 per role.
  [sol I3a]
- **S-6** Netting: absolute-total + atomic superseding snapshot (above);
  R-JRN-12's stale identity-netting sentence rewritten. [sol I3b + fable
  F6]
- **S-7** Dead-holder identity: ESRCH-only (generic kill failure ≠ dead) +
  OS-derived start-time compared against token `birth_ts_ms`; cancel
  signaling uses the same check. [sol I4 ⊃ fable F8]
- **S-8** P-4 residuals: R-REG-5, R-REG-6, and the snapshot-first intake
  line reworded to final-path + campaign.json-last (fable F3);
  incomplete-registration repair path — re-entry may remove-and-recreate a
  worktree failing identity verification, under the flock, loud (sol I5);
  prefix-collision rule covers digest-less incomplete dirs (fable F10).
- **S-9** Ballast: created before the campaign.json rename; non-sparse
  allocation + fsync; honest limits extended (inodes, sparse, WAL
  amplification); fate table gains `adjudication` (recomputed at resume);
  step-3 filename fixed to `.ballast`. [sol I6 ⊃ fable F4/F5]
- **S-10** Antigravity matcher row rewritten to shipped truth (bare 429
  matches `agyLogShowsRateLimit`; hex-embedded excluded — sol probed
  live); anchored-structure discipline applies to the new families; the
  contradicted false-positive claim withdrawn. [sol I7]
- **S-11** ID injectivity: component charset restriction (schema
  amendment, joins the contract-additions list) or delimiter escaping;
  rerun-lineage id rule pinned (lineage-root + seq). [sol I8 + fable F9]
- **S-12** Reserve-exhaustion carrier unified: the `reserve_exhausted`
  adjudication is the sole carrier; R-DSP-9, seal clause 3, and E7.3a
  reworded away from the unreachable `slot_exhausted`/`exhausted` path in
  those scenarios. [fable F7]
- **S-13** Judgment calls recorded: roster-on-mint RATIFIED (both seats);
  `subject_rate_limited` RATIFIED (both seats; rides the E7 cause
  additions); netting per S-6.

---

# Revision 4 + final verify (2026-08-26, fourth round — GATE CLEARED)

**Drafter change (Drew-directed):** after three qwen rounds each leaving a
Critical in E7's core, Drew chose **sol as the round-4 drafter** (agent
`1e2cb269`, fast mode, max; the S-1…S-13 list left no design freedom).
Revision 4 (2,769 lines): all 13 S-items landed with agreement sweeps;
zero disputes; S-6 drafted exactly as adjudicated; the six mandated
crash-scenario hand-replays documented step-by-journaled-step; D-1/D-2/D-3
untouched; `bun run check` + `bun run quorum check` green; remaining proof
debt (OS start-time reader, ballast/ENOSPC fault injection) honestly
marked asserted-not-proven, owed to the Linux matrix.

**Final cross-family verify (fable-family, agent `d8261c07`, xhigh):**
**READY-WITH-FIXES — Minors only, nothing blocks ratification.** All 13
S-items verified landed with sweep evidence; **all six replays
independently re-derived** (not trusted from the report) and converging —
including the load-bearing details: the post-crash cancel path must
complete roster dispositions BEFORE journaling `aborted` (order is
load-bearing, pinned); the reserve-exhaustion-vs-budget-stop race
serializes off durable journal facts to exactly one adjudication in every
interleaving; the same-id rerun seal race now refuses until post-mint
witnesses exist. D-1/D-2/D-3 substance verified faithful against the gate
record (byte-diff impossible — no rev-3 copy exists; the file is
untracked). One inherited-not-introduced note: a never-resumed aborted
block seals as accounted shortfall (shipped D1 fold semantics).

**Three Minors, all editorial with dictated fixes, applied directly by
the orchestrator post-verdict** (same-family application accepted for
verbatim editorial pins): (1) "included terminal sample" pinned as the
derived property — completed, non-superseded, successor-local terminal;
the `included` disposition stays D4's optional record; E7.3a chain check
binding for superseded samples; (2) routing table `budget_stopped` →
"each named sample"; (3) the exit-criteria ratification line now names
all three ratification items (E7, ENOSPC fail-stop, schema amendments).
Verifier's no-action pedantic notes left as-is.

**Gate outcome: the spec (revision 4 + minors) is ratification-ready.**
The ratification set: (1) proposed D1 erratum E7 (incl. roster-on-mint,
`subject_rate_limited`, S-6 netting — all seat-ratified); (2) the ENOSPC
fail-stop override of revision 1's children-keep-running pause; (3) the
additive D1-schema amendments in the contract-additions list. Optional
Drew re-open carried since round 1: OQ-11 contention-invalidation timing
(seal-time stands per the gate unless he re-opens). After ratification:
status flip to ratified/approved, commit the spec + gate + review records,
then `writing-plans` → plan review → SDD execution.
