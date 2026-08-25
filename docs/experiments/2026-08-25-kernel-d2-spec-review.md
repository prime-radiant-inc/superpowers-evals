# Kernel D2 provisioning + instrument-snapshot spec — five-seat review record

**Date:** 2026-08-25
**Subject:** `docs/superpowers/specs/2026-08-25-kernel-d2-provisioning-instrument-snapshot-design.md`
at revision 1 (main @ `15fa19a`)
**Panel:** five independent read-only seats dispatched in parallel
(repo-grounded, no shared context):

- **Sol — codebase fidelity:** every claim checked against the codebase
  (adapter inventories, runner threading sites, citations, line references).
- **Fable — parent-spec compliance:** deviations, missing obligations,
  quotation fidelity, errata hygiene.
- **k3 — architecture:** decision soundness, module boundaries, cut-list
  discipline.
- **qwen — testability:** buildability of the acceptance bar, vacuity of
  smoke assertions, harness realism.
- **GLM — adversarial:** failure modes under hostile operators, concurrency,
  crash/resume, provenance forgery.

**Verdicts:** all five **NEEDS REVISION**. 13 themed dispositions (T1–T13);
every finding absorbed, none rejected. k3's headline governs the revision's
shape: the architecture is sound, Decisions D-1…D-5 all survive, this is a
patch pass, not a redesign.

Revision 2 of the spec absorbs every accepted finding; this record carries
the dispositions.

## Convergent findings (found independently by ≥2 seats)

| # | Finding | Seats | Disposition |
|---|---|---|---|
| C1 | **None-mode launcher contradiction:** claude/serf/pi launcher templates embed `$SUPERPOWERS_ROOT` unconditionally; for claude this is the only superpowers channel (`ClaudeAgent.provision` stages nothing), so the spec's fail-loud rule kills its own smoke adapter at context population, and "no staging artifacts in the run home" is vacuous for claude | Sol #3, qwen #1, k3 #1, GLM P2-3 (four seats) | **Absorbed as T1** — code-reality corrected (ten adapters; claude's channel named); structured launcher placeholder (`$SUPERPOWERS_PLUGIN_ARGS`, flags elided in none mode, byte-identical legacy expansion); fail-loud rule honestly scoped via `forbiddenPlaceholders`; misattribution reworded; smoke assertion made behavioral with a differing-HEAD precondition (qwen's vacuity analysis) |
| C2 | **`required_env` is an unlisted ambient gate:** the runner validates every YAML's `required_env` against the ambient env (`src/contracts/agent-config.ts:215-224`, invoked `src/runner/index.ts:1245`, re-checked `:1336`); all ten YAMLs declare `SUPERPOWERS_ROOT`, so both explicit modes fail or mis-gate before the threaded value reaches anything | Sol #1, qwen #2 | **Absorbed as T2** — threading site 6 (required-env resolution against the effective environment); duplicate checks reconciled; hermetic matrix gains none-mode-without-ambient and root-mode-with-ambient-unset |

## Seat dispositions

### Sol (codebase fidelity)

| Finding | Severity | Disposition |
|---|---|---|
| #1 `required_env` ambient gate | P1 | Absorbed as T2 (with qwen #2; C2) |
| #2 adapter inventory is ten, not nine | P1 | Absorbed as T3 — explicit enumeration everywhere; claude-windows legacy read recorded; `--os windows` mixed-state rejection added |
| #3 none-mode launcher contradiction | P1 | Absorbed as T1 (C1) |
| #4 D-5 "for free" has an unstated precondition (`repoRoot()` is module-URL-derived; the internal run-child path would execute the originating checkout) | P1 | Absorbed as T7 — snapshot-entrypoint addressing pinned in D-5 + exit criteria; hostile originating-checkout test added |
| #5 no channel binds `gauntletRoot` to the executed gauntlet binary | P1 | Absorbed as T6 (with Fable #3, k3 #2) |
| #6 registry alias resolution (`runtime_family ?? name`) | P1 | Absorbed as T9(a) |
| #7 materializer env projections inherit parent env | P2 | Absorbed as T10.1 |
| #8 CLI projection completeness + false run-all in-process claim | P1 | Absorbed as T12 — both parsers + child-argv builder pinned; code-reality corrected |
| #9 cite `ArmSuperpowersSchema` (`arm.ts:6-11`) consumed by `ArmSchema.superpowers` | P3 | Absorbed as T13.2 |

### Fable (parent-spec compliance)

| Finding | Severity | Disposition |
|---|---|---|
| #1 unrecorded deviation: explicit-args threading replaces the parent's pinned env injection | P1 | Absorbed as T8 — Decision D-6 with rationale, full parent quotations, and parent erratum E6 verbatim |
| #2 registry flip circularity (only claude flagged → D3 rejects the arms qualification needs) | P2 | Absorbed as T9(b) — per-adapter flip PRs with two-mode live smoke, landed between D2 and qualification |
| #3 no `gauntletRoot`↔binary binding (spec deferred "the exact site") | P1 | Absorbed as T6 — Fable's shape adopted, D2-owned per k3 |
| #4 null-vs-"absent" `superpowers_rev` reconciliation | P3 | Absorbed as T13.4 — recorded as an E-series note, not a text change |
| #5 parent quote with ellipsis; Appendix B `refs.gauntlet` orphaned from the materialization | P3 | Absorbed as T13.5 — full quote restored; `Campaign.refs.{evals,gauntlet}` reconciliation + digest-vs-HEAD+porcelain equivalence recorded |
| #6 fail-loud misattribution (the `requires_superpowers` exclusion doesn't exist when D2 ships) | P1 | Absorbed as T1.4 — reworded: D3 registration filter, fail-loud substitution is the only guard until then |
| #7 adapter count | P3 | Absorbed as T3 |

### k3 (architecture)

| Finding | Severity | Disposition |
|---|---|---|
| #1 none-mode launcher contradiction | P1 | Absorbed as T1 (C1) — k3's fix adopted and expanded |
| #2 gauntlet binary binding unowned | P1 | Absorbed as T6 — Fable's shape, D2-owned per k3 |
| #3 (P2-3) `verifySnapshot` cannot see the superpowers worktrees | P2 | Absorbed as T4 (with GLM P1-1) — plus k3's addition: re-materialization `ProvisioningError` maps to admission halt like `SnapshotDriftError` |
| #4 provenance override precedence | P2 | Absorbed as T11 (with GLM P2-7, qwen) |
| P3-5 one shared tri-state helper (`resolveSuperpowersRoot`) | P3 | Absorbed as T13.1 |
| P3-6 D-5 precondition | P3 | Absorbed as T7 (with Sol #4, GLM P2-8) |
| P3-8 materializer hardening | P3 | Absorbed as T10 (member of the hardening set) |
| P3-9 teardown via `git worktree remove`/`prune`, never `rm -rf` | P3 | Absorbed as T10.5 |

### qwen (testability)

| Finding | Severity | Disposition |
|---|---|---|
| #1 none-mode launcher contradiction, incl. provenance-readback vacuity | P1 | Absorbed as T1 (C1) — differing-HEAD smoke precondition adopted |
| #2 `required_env` ambient gate (evidenced by `test/cli-run.test.ts`'s fake seed) | P1 | Absorbed as T2 (C2) |
| adapter-count contribution | P3 | Absorbed as T3 |
| materializer env projections | P2 | Absorbed as T10.1 (with Sol #7) |
| substitution-map citation (built at `src/runner/index.ts:1546`; `context.ts` only consumes) | P3 | Absorbed as T13.3 |
| provenance override precedence | P2 | Absorbed as T11 |
| CLI forwarding tests + run-all claim | P2 | Absorbed as T12 |

(qwen findings beyond #1/#2 are consolidated from the seat's report; the
dispositions doc cites them by theme rather than by number.)

### GLM (adversarial)

| Finding | Severity | Disposition |
|---|---|---|
| P1-1 `verifySnapshot` cannot see the superpowers worktrees (`SnapshotHandle` carries evals+gauntlet only; uncommitted edits leave HEAD at the registered SHA) | P1 | Absorbed as T4 — GLM's shape: `superpowersWorktrees` field + three-tree verify |
| P1-2 verify cadence leaves in-flight + post-final-wave drift undetectable | P1 | Absorbed as T5 — per-admission-wave / block-terminal / pre-seal cadence pinned; accepted residual recorded |
| P2-3 none-mode launcher contradiction | P2 | Absorbed as T1 (C1) |
| P2-4 failure cleanup + crash re-entry | P2 | Absorbed as T10.3 |
| P2-5 concurrency / same-SHA races | P2 | Absorbed as T10.4 — kept at the seat's P2 rating; the contract clause is mandatory (see downgrades) |
| P2-6 sha/dest validation | P2 | Absorbed as T10.2 — kept at the seat's P2 rating; the contract clause is mandatory (see downgrades) |
| P2-7 provenance override precedence | P2 | Absorbed as T11 |
| P2-8 D-5 precondition | P2 | Absorbed as T7 |
| P3 teardown discipline | P3 | Absorbed as T10.5 (with k3 P3-9) |

## Out of scope / rejected

Nothing. Every finding above is absorbed. The only severity adjustments vs
the seats' ratings: GLM P2-6 (sha validation) and GLM P2-5 (concurrency) are
absorbed at the seats' P2 wording but with **mandatory** contract clauses —
the fixes are one clause + one test each, and the hazard class is F13's, so
the clauses are not optional.

## Honest correction (ledger accuracy)

k3's review reported "no missed ambient read" as verified. That verification
missed the `required_env` preflight read (`loadAgentConfig`,
`src/contracts/agent-config.ts:215-224`, invoked and re-checked runner-side)
that Sol (#1) and qwen (#2) documented. Recorded here so the ledger is
accurate about which seat caught what: the `required_env` gate was found by
Sol and qwen, not k3.

## Revision-shape note

Per k3's headline: no decision is reversed, no module is redesigned, the cut
list stands. Revision 2 adds one Decision (D-6), one threading site (site 6),
one launcher-placeholder mechanism, three `SnapshotHandle` fields
(`gauntletBin`, `superpowersWorktrees`, and the resume reconstruction
contract), the verify-cadence contract, and the materializer hardening
clauses. It also corrects four factual claims (claude's channel, the adapter
count, the run-all in-process claim, two citations). The acceptance-bar
substance is unchanged — hermetic gates plus one live claude smoke — with the
smoke's assertions made behavioral and its precondition hardened against
vacuity.
