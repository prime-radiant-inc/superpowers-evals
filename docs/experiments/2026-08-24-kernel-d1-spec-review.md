# Kernel D1 contracts spec — three-seat review record

**Date:** 2026-08-24
**Subject:** `docs/superpowers/specs/2026-08-24-kernel-d1-contracts-design.md`
at revision 1 (commit `464ba5f`)
**Panel:** three independent read-only seats dispatched in parallel
(general-purpose subagents, repo-grounded, no shared context):

- **Seat 1 — contract fidelity:** every claim checked against the parent
  spec text and the codebase (48 tool calls).
- **Seat 2 — parent-spec compliance:** deviations, missing obligations,
  orphaned scope, errata hygiene (15 tool calls).
- **Seat 3 — engineering/testability:** buildability, seams, hazards,
  fixture availability (77 tool calls).

**Verdicts:** all three **NEEDS REVISION**. 14 P1 findings, 27 P2
findings, eight cross-seat convergences. All defects are spec-text
repairs; no architectural rework — the scope decomposition, seam-map
concept, and the Appendix B transcription core were confirmed sound by
all three seats (their verified-claims ledgers are appended to the
session record).

Revision 2 of the spec absorbs every accepted finding; this record
carries the dispositions.

## Convergent findings (found independently by ≥2 seats)

| # | Finding | Seats | Disposition |
|---|---|---|---|
| C1 | `run_allocated`: D1's env-sink seam silently replaced the parent-pinned child-protocol/`onRunDir` mechanism (parent Identity names it; `src/runner/index.ts:409,957-960` exists) | S1-P2-7, S2-P1-1, S3-P1-3 | **Accepted — re-pinned to the parent seam.** Env sink retired. Dispatcher owns pgid via a pinned setsid spawn contract; `key_env` added to the journal payload; journaling order and residual window pinned. |
| C2 | Decision D-2's precedent was false: Phase 0 campaign zod lives in `src/contracts/replay.ts`/`estimates.ts`, not `src/campaign/` | S1-P1-5, S3-P2-1 | **Accepted.** Contracts move to `src/contracts/campaign/`; precedent cited correctly. |
| C3 | Expected-check manifest field is `count` with nullable `args` (`src/contracts/check-manifest.ts:9,11`), not `multiplicity` | S1-P1-4, S3-P2-9a | **Accepted.** Shape corrected. |
| C4 | "Phase 0's simulator over FakeClock" is false (pure virtual-time engine; FakeClock is the scheduler seam) | S1-P1-7, S3-P2-9b | **Accepted.** Inputs section corrected. |
| C5 | No existing on-disk verdict fixture parses `FinalVerdictSchema` (four fixtures are deliberately partial/legacy) | S1-P1-6, S3-P2-11 | **Accepted.** Back-compat baseline reworded: committed inline shapes + one new complete fixture; structural guarantee (non-strict + optional) cited. |
| C6 | Suite schema missing the `tier=<sentinel\|full\|adhoc>` selector grammar (parent Concepts; `readQuorumTier` in `src/story-meta.ts`) | S2-P2-4, S3-P2-9d | **Accepted.** Grammar pinned; registration expands tier tokens; Campaign stores the expanded form. |
| C7 | Cell `class` vocabulary must be the closed parent enum `confirmatory \| probe \| tripwire \| descriptive` | S3-P2-9c (+ parent Concepts, read directly) | **Accepted.** Enum pinned. |
| C8 | `release_gate_v1` parameter list underfits the parent: missing "deltas" (pre-registered MDE) and the tripwire firing criterion | S1-P1-2, S2-P1-3, S2-P2-8 | **Accepted.** `mde_by_scenario` parameter added; tripwire criterion pinned (registered expectation, fail-closed). |

## Seat 1 (contract fidelity) — dispositions

| Finding | Disposition |
|---|---|
| P1-1 exploratory `reserve` rejection invented (parent: optional, default 0) | Accepted — parent rule transcribed |
| P1-2 parameters drop deltas/MDE | Accepted (C8) |
| P1-3 Campaign `comparisons[]` required-`baseline` breaks single-arm; `sample_ids` hard-coded 2-tuple | Accepted — discriminated union + non-empty array |
| P1-4 manifest field `count` not `multiplicity` | Accepted (C3) |
| P1-5 D-2 precedent fabricated | Accepted (C2) |
| P1-6 verdict-fixture regression promise unsatisfiable | Accepted (C5) |
| P1-7 FakeClock claim false | Accepted (C4) |
| P2-1 copilot manifest pool IDs don't follow the formula | Accepted — D-4 names the gate manifest only; copilot deviation recorded |
| P2-2 gating requirements drop `max_exposure_skew` | Accepted — required list corrected |
| P2-3 arm rejection narrowed `none` → `none`/ref | Accepted — parent wording restored |
| P2-4 Arm `name` regex + `os` enum unmarked pins | Accepted — os validated against the os-target vocabulary (`src/contracts/os-target.ts`); name regex marked pinned-here with rationale |
| P2-5 cardinality invariants labeled "pinned here" but are parent Identity text | Accepted — provenance label fixed |
| P2-6 digest exclusion attributed to "the Phase 0 settlement" | Accepted — it is the parent's Appendix B text; prose fixed |
| P2-7 D-3 silent mechanism substitution | Subsumed by C1 |

## Seat 2 (parent-spec compliance) — dispositions

| Finding | Disposition |
|---|---|
| P1-1 `run_allocated` mechanism swap | Accepted (C1) |
| P1-2 `analysis_exposure_started_at` orphaned (no owner, no source, name absent) | Accepted — dedicated contract section: name, definition, owner (sensors/D3), source precedence, forbidden sources, fail-closed absence |
| P1-3 tripwire v1 firing criterion missing | Accepted (C8) |
| P2-1 `budget_stopped` admitted-edge extension deserves an erratum | Accepted — proposed parent erratum E3 |
| P2-2 `key_pool` deserves an erratum; "by construction" overstates | Accepted — erratum E4; softened to "by operator discipline" with the observed-identity guard named |
| P2-3 typed-failure cause surface unpinned | Accepted — codomain enum + initial `InstrumentCause` union pinned in D1; closed set completed by the D3 classifier table |
| P2-4 `tier=` selector missing | Accepted (C6) |
| P2-5 journal `schema_version` row absent | Accepted — named as the D3 journal module's storage obligation |
| P2-6 "stamped before first provider token" obligation homeless | Accepted — carried by the spawn/key-select seam row + Verdict extension section |
| P2-7 warning threshold "5" mislabeled as probed | Accepted — relabeled "the single-key cap 5 Phase 0 modeled" |
| P2-8 MDE has no contract home | Accepted (C8) — MDE is registration-frozen via `mde_by_scenario` |
| P2-9 errata hygiene summary | Accepted — Errata section lists E3/E4/E5 + the SHA-256 note |

## Seat 3 (engineering/testability) — dispositions

| Finding | Disposition |
|---|---|
| P1-1 pinned edge set forbids parent-mandated late transitions; reject semantics undefined | Accepted — three-valued transition function (`apply \| ignore-late \| reject`); disposition edges from `spawned/exposed/completed`; per-terminal late-event policy pinned; retained-evidence sequences are golden streams |
| P1-2 no event drives `running → cancelled`; campaign mapping unpinned | Accepted — `campaign_cancelled` added (20th event, erratum E5); full campaign edge→event mapping pinned incl. the `storage_paused` derivation rule |
| P1-3 pgid contract depends on an unpinned spawner convention | Accepted (via C1 re-pin) — setsid/process-group-leader spawn contract pinned; pgid == child pid validation; v1 host-direct; container two-tier model recorded as restart point; current non-detached spawn sites named as not-to-copy |
| P1-4 JCS implementation contract unpinned; no dependency | Accepted — hand-rolled `digest.ts` contract pinned (UTF-16 code-unit sort, ES6 serialization, NaN/Infinity rejection), RFC 8785 Appendix vectors as committed fixtures, no new dependency; `container.ts:979` failure mode named |
| P2-1 D-2 precedent | Subsumed by C2 |
| P2-2 poolKey golden input non-hermetic | Accepted — gate-era credential snapshot (`64b99fc`) committed as fixture; gate manifest only |
| P2-3 KeySelector `wait` unreachable under honest admission; grants not journaled | Accepted — authority relationship pinned (admission cap authoritative; `wait` = miscalibration/recovery guard); `key_env` added to the `run_allocated` payload |
| P2-4 key_pool silent fallback to harness-conventional env | Accepted — fail-loud resolution requirement pinned as a D3 obligation |
| P2-5 sink concurrency profile | Moot after C1 re-pin (no shared sink file); protocol-line discipline pinned instead |
| P2-6 emission→journal crash window | Accepted — journaling order pinned (attempt_created pre-spawn per parent Identity; run_allocated same critical section post-spawn); residual orphan bounded by attempt_bounds + quarantine, documented |
| P2-7 `quorum check` discovery conventions absent; layout homes misattributed | Accepted — `arms/` + `suites/` pinned (parent Concepts examples); check homes corrected (`src/credentials/check.ts`, `src/story-meta.ts`/`src/scaffold.ts`); cross-reference precedent `checkCredentials` cited |
| P2-8 static-scan vocabulary undefined | Accepted — path-shaped heuristics pinned, no skill inventory, no `SUPERPOWERS_ROOT` requirement |
| P2-9 factual slips | Accepted (C3, C4, C6, C7) |
| P2-10 profile registry as mutable global | Accepted — frozen built-in map, injected, explicit extension point |
| P2-11 fold mechanics unpinned; fixture corpus overstated | Accepted — fold point (`src/checks/index.ts`), fold format and collision semantics pinned; corpus rewording subsumed by C5 |

## Controller's own finding (during revision)

- Parent Concepts says operator-declared per-token pricing overrides are
  "recorded in `campaign.json`"; Appendix B's Campaign field list omits
  them. Reconciled in revision 2 by adding `pricing_overrides?` (marked
  pinned-here, citing both parent locations). Not filed as an erratum —
  reconciliation, not deviation.

## Verified-clean areas (all three ledgers agree)

Appendix B transcription core: digest exclusion list, 19-event
vocabulary names, both state-machine terminal sets, crash windows,
verdict extension fields, Report schema (accounting nine items,
registered-vs-observed-set provenance, stamp/verdict iff-rules,
byte-stability trio), credential strictness, `poolKey` formula vs parent
Execution, `limiterKey` coexistence, every Phase 0 number cited
(18/36 configs, grader cap ≥15, 16.05h single-key wall, 7.6h grader
wait, PRI-2524 promotion), gate-era credential resolution at `64b99fc`,
`onRunDir` seam existence, F13 projection seam, `quorum_max_time`
default source, k-arm ban, grader singularity, E1/E2 citation.
