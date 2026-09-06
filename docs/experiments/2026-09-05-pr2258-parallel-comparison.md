# PR 2258 parallel comparison preparation

Date: September 5, 2026. Tracking: PRI-3097.

## Question and frozen method

Measure the base/head effect of Superpowers PR 2258 within Codex Astra, Codex
Sol, and Claude Opus 5 on `brainstorming-todo-shared-intent`. This is n=2 on one
case, exploratory evidence rather than a general model ranking. Each comparison
uses base `fd02874aa5c55ba3c2bca431253b48e0e4c8be5a` and head
`069edf3ffc2ffdce80a84d3344a4064acec7e10c`.

The measured cohort is twelve fresh samples, with reserve 0, max_attempts 1,
target capacity six and within-pair exposure skew at most 60 seconds. A separately
registered six-arm n=1 diagnostic precedes measurement and contributes no measured
samples. Neither diagnostic nor measured execution has been launched for this
preparation record. Prior serial pilot results remain in
[the September 4 pilot log](2026-09-04-pr2258-astra-sol-brainstorming.md).

## Staff review and authorization

Sol, Fable, K3 and Qwen independently reviewed the design, then reconciled concrete
source counterexamples. Drew approved amending the spec and beginning source
implementation. The amended
[spec](../superpowers/specs/2026-09-05-pr2258-parallel-comparison-design.md) is
committed at `99206154`; the initial source baseline is `672a0ad2`.

The primary behavioral readout is a preregistered strict-observer pair cohort,
with the generic composed cohort unchanged and a separate denominator. Missing
or disputed evidence stays visible. Independent cosmetic labels bind sealed
artifacts and do not change strict scores. Every measured run needs independent
review before interpretation.

## Source implementation sequence

The first [implementation plan](../superpowers/plans/2026-09-05-pr2258-campaign-foundations.md)
has four independently reviewed tasks:

1. Isolated non-credential-bearing check HOME and a real checks-bearing runner
   publication regression. Preserve manifest exclusions and strict inventory.
2. Repetition-first admission after duration priority, including a real first-six
   controller activation test and total-order coverage.
3. Per-entry unreadable campaign listing, preserving exact/prefix execution
   resolution and historical artifacts.
4. Explicit suite pricing path/digest, verified at registration and worker
   preparation and delivered through the existing read-only Evals mount.

The first three tasks begin from plan commit `163aca3d`; pricing delivery is
planned at `09ba1fb4`. Integration runs in branch
`codex/pr2258-parallel-comparison-impl`. Workers use isolated branches and focused
tests; the controller owns review and the integrated full check.

## Baseline evidence

On the unchanged source in the isolated implementation worktree, `bun run check`
passed lint and typecheck, then ran 3,507 core tests: 3,492 passed, 14 skipped and
one failed by exceeding its 5,000 ms timeout. The failure was
`quorum run embeds linux in run-id when --os linux is explicit` in
`test/cli-run.test.ts`. A focused rerun of the whole CLI test file passed 8/8 in
2.31 seconds without changing source. Preserve the original timeout as a baseline
receipt; do not claim a completely clean initial full check. Dashboard checks
were not reached in that failed invocation.

## Foundation implementation receipts

All four tasks are implemented in the isolated integration branch and passed
independent spec-compliance and code-quality reviews:

| Task | Integrated commit | Focused tests reported by implementer |
| --- | --- | --- |
| Check HOME and runner publication | `acf15356` | 68 passed |
| Repetition-first admission | `fbee7c97` | 60 passed |
| Per-entry campaign listing | `2931ddbf` | 9 passed |
| Pinned worker pricing | `b42cf5a0` | 119 passed |

Implementers recorded failing behavior before their fixes, then passing focused
regressions, lint and typecheck. The pricing proof runs a fresh local Bun process
through the prepared public environment and real accounting functions; it does
not constitute an installed Linux worker qualification or establish production
Opus 5 rates.

The integrated `bun run check` at `b42cf5a0` exited successfully: lint and
typecheck passed; core tests had 3,515 passes, 14 skips and no failures across
249 files (176.43 seconds); dashboard tests had 144 passes and no failures.
`bun run quorum check` passed all 88 scenario/credential/arm-suite checks.
`git diff --check` was clean. The baseline CLI timeout did not recur.

The 14 core skips cover a Windows hook check, the real Gauntlet/TUI integration,
and twelve Linux/container qualification cases. These remain unverified here;
local injected-runtime and subprocess tests do not substitute for them.

One plan correction was necessary: add optional absolute `OBOL_PRICING_DIR` to
the strict runtime public-environment schema, because otherwise the runtime
would reject its own verified pricing projection. This introduces a path-bearing
runtime field; the shared no-follow digest verifier and strict rejection of
unknown environment keys bound that authority. No ambient pricing fallback is
permitted when a snapshot is selected.

Final whole-branch review found one correctness gap: credential delivery could
overwrite the verified pricing directory at launch. The single fix wave
(`19f52646`, worker commit `110288c0`) rejects `OBOL_PRICING_DIR` in credential
`api_key_env` and `key_pool`, and independently protects it at the real
entrypoint. The regression reproduced actual worker launch under the conflicting
value, then proved refusal before the worker side effect. Focused verification
went from 42 passes/3 expected failures to 45 passes/no failures; lint and
typecheck passed. The scoped re-review marked the finding addressed and found
no residual issue or new breakage.

The final integrated `bun run check` at `19f52646` also exited successfully:
lint/typecheck passed, core tests had 3,518 passes, the same 14 qualification
skips and no failures (174.21 seconds), and dashboard tests had 144 passes and
no failures. Final `bun run quorum check` passed all 88 checks, and
`git diff --check` was clean. The four-task foundation plan is complete; these
receipts supersede the earlier source-test totals without erasing the original
baseline timeout or the final review's negative finding.

The full observer implementation and live comparison remain unfinished;
PRI-3097 remains In Dev.

## Evidence integration dependency

Planning found that Gauntlet's current private-TUI shutdown snapshots bare PIDs,
does not verify final absence after SIGKILL, and can treat process enumeration
failure as an empty list. Gauntlet exit or stable transcript bytes therefore
cannot establish the termination proof required by the amended spec.

The initial proposed response was a Gauntlet-owned lifecycle supervisor. Drew
challenged its complexity and approved a simpler replacement: retain candidate
capture/scoring in the worker, then verify the bound source state against that
candidate after the existing exact container-stop proof and before publication.
The publisher refuses mismatches rather than repairing evidence. This supersedes
the in-worker termination-proof requirement and retires the supervisor proposal
before implementation. The five-second hard-kill grace remains unchanged.

## Raw observer and termination work

Drew requested continuing implementation after the verified foundations. The
next independent source slice introduces pure V2 raw indexes and byte-prefix
verification. Existing V1 capture/scoring, CLI routing and scenario eligibility
remain at their historical instrument until the complete new path is ready.

The checked-in Claude `2.1.177` trace identifies `entrypoint: sdk-cli` and
`promptSource: sdk`. Queue-prefix and content-shape tests can use those bytes;
parent-TUI identity and external approval eligibility remain unqualified.
Synthetic fixtures must be labeled separately from captured evidence.

The [raw-index plan](../superpowers/plans/2026-09-05-pr2258-raw-observer-index.md)
was committed at `202d722f`. Its shared contract is implemented at `ec069d5a`
with the reviewed primitive-row correction at `9b4b959f`. The implementer
reported 29 focused passes, 101 assertions, clean lint and typecheck. Review
found that the first parser accepted scalar JSON records; the regression
reproduced four such cases before the explicit object guard fixed them.
A separate regression caught BOM stripping at a later physical line. The
corrected contract passed scoped re-review before adapter implementation began.

Both adapters were implemented in independent worktrees against that fixed
contract and passed their task reviews after targeted fixes:

| Task | Integrated commits | Focused verification reported |
| --- | --- | --- |
| Shared raw contract | `ec069d5a`, `9b4b959f` | 29 passes, 101 assertions |
| Codex raw index | `6a0e247b`, `097c970b` | 135 passes, 466 assertions including shared/V1 regressions |
| Claude raw index | `7a12467e`, `bddd84ec` | 94 passes, 296 assertions including shared/normalizer regressions |

Codex review found that local-shell and web-search calls dropped supplied native
IDs, breaking replay/conflict detection and result linkage. Both variants now
retain supplied IDs and otherwise use original-anchor IDs. Claude review found
that a late sidechain marker rewrote earlier entries and that non-message
envelopes could hide result metadata. Regressions reproduced those failures;
the fixes preserve occurrence-time entries and reject the hidden metadata.
Task re-reviews found those issues addressed. Final review resolved the minor
ID-less web-search coverage note: the all-supported-variants test checks the
anchor-derived ID and payload, and repeated fallback behavior is covered.

Implementation decisions recorded during the slice:

- Native calls without a name retain their raw discriminant. This avoids invented
  semantic labels; a future display mapping may still be needed.
- Each adapter builds its prefix from the same validated bytes and row count
  rather than parsing twice. Two small assemblies could drift, so tests compare
  their output with the shared prefix helper and use the same strict schema.
- Mixed Claude text/result rows retain the observed external-origin claim, but
  that claim never grants approval authority. Consumers must keep those distinct;
  no Claude entry is eligible in this increment.
- Later descendant evidence updates final source identity without changing prior
  entry values. Consumers must check both final identity and occurrence-time
  eligibility; the index does not manufacture earlier provenance.

The integrated source at `097c970b` passed `bun run check`: lint/typecheck,
3,597 core passes with 14 qualification skips and no failures (173.41 seconds),
and 144 dashboard passes with no failures. `bun run quorum check` passed all
88 checks and `git diff --check` was clean.

Final whole-slice review then found that the installed Zod record parser drops
valid own `__proto__` keys inside opaque raw payloads. It also found missing
multibyte/CRLF coverage in the two adapter prefix-parity tests. The single fix wave at `de769cca` (worker `25754ed7`) validates opaque JSON
without reconstructing it. Both adapters now test nested call/result own-key
preservation and absence of prototype pollution; both prefix tests include
multibyte UTF-8 and CRLF. Reported verification went from 50 passes/two expected
failures to 52 passes/no failures; the covering observer suite passed all
81 tests with 383 assertions. Lint and typecheck passed. Scoped re-review marked both findings addressed,
with no new breakage or out-of-scope observations.

Final integrated `bun run check` at `de769cca` exited successfully: lint/typecheck
passed, core tests had 3,599 passes, the same 14 qualification skips and no
failures (173.39 seconds), and dashboard tests had 144 passes and no failures.
`bun run quorum check` passed all 88 checks, and `git diff --check` was clean.
These final receipts supersede the earlier totals while retaining the negative
review findings and regression history. All three raw-index plan tasks and
the final review gate are complete. The modules remain inactive and offline;
full observer support and the six-arm comparison remain unfinished. The Codex grammar deliberately rejects the complete
checked-in slice at its first unsupported `turn_context` row; selected-row tests
are shape evidence only. Nonempty reviewed suffixes are always rejected until a
separate exact-build grammar is qualified.

The [Gauntlet termination proposal](../superpowers/specs/2026-09-05-gauntlet-observer-termination-design.md)
was retired after Drew's simplification decision. The Gauntlet checkout was read
only; its unrelated untracked files remain untouched. Linear returned an upstream
502 during the earlier continuation; tracking stays with the existing PRI-3097
record.

## Final-state verification amendment

Drew approved using the existing stopped-container publication boundary. Source
inspection at `1b913a93` confirms that `publishExecution` requires the exact
`inspected_stopped` identity before invoking `publishAttempt`, which verifies the
manifest/inventory and atomically moves staging. The new evidence check belongs
before that move. Its required source roots and observer expectation must come
from trusted execution/binding data so a missing candidate cannot disable it.

Candidate scoring remains provisional until full bound raw-log and terminal
artifact inventories match the final source state. Late appends, changed bytes,
source replacements, additions/deletions, unreadable state, and incomplete or
missing candidates make evidence unusable. No host repair, manifest rewrite,
rescoring or automatic replacement is allowed. Even a harmless late flush can
therefore lose a sample; that explicit limitation is accepted instead of adding
a process-management subsystem. Final-state equality does not prove absence of
intermediate writes; live receipts and raw chronology still carry that evidence.

Required targeted evidence includes unchanged publication, a deliberate late
writer refused before rename, source/identity substitution, an added/deleted
artifact, a hard-kill partial candidate, and copied-bundle replay after private
source paths disappear. No source or live qualification of this amendment is
claimed by this documentation update. The next [source plan](../superpowers/plans/2026-09-05-pr2258-final-state-verification.md)
builds the shared filesystem capture/verification primitive as one task. Runtime
activation stays with the complete V2 binding/candidate producer so an optional
missing bundle cannot bypass the eventual publication check. Plan/spec amendment
was committed at `2f12e7fc`. A fresh Linear read confirms PRI-3097 is In Dev; the
earlier 502 was transient and did not require a duplicate ticket.

## Final-state filesystem implementation

The one-task filesystem slice began at worker commit `c8ec4274` and is complete
through integrated source `adc7f576`, including the review fixes below.
`captureFinalState` and `verifyFinalState` share one traversal over
caller-supplied transcript/artifact roots. Inventories retain relative paths,
exact file hashes/lengths and device/inode identities; candidate validation
cannot select source paths. Full JSONL additions/appends and all scoped artifact
changes invalidate the candidate, including same-byte source replacement. Pinned
no-follow byte reads and observation rechecks reject unsafe or unstable sources.
Neither operation mutates sources or candidate evidence.

The implementer reported missing-module RED/GREEN and a second behavioral RED:
without the comparison, a late append was accepted. The completed comparison
rejects it. An actual child fixture appends after capture and exits before the
refusal check. Focused final-state tests passed 27 cases/188 assertions; the
combined raw/final-state gate passed 56 tests/289 assertions, lint checked 554
files, and typecheck/diff checks passed. Task review then found a root-pin
lifetime race: the root was pinned and closed before path-based traversal,
leaving a substitution interval. It also found source failures incorrectly
classified as candidate errors or changes. The first fix round (`a01e9994`,
worker `5ef013e0`) retains the root pin, walks its identity path and rechecks
the caller binding before/after traversal. It preserves access-error versus
disappearance distinctions and reports unrepresentable observed names as source
errors. Actual root and ancestor renames plus error-code regressions produced
four expected failures before the fix. The final scoped gate passed 61 tests/301
assertions with lint/typecheck clean. Original implementation `c8ec4274`
integrated as `e22ad002`. Scoped re-review accepted the retained-pin fix but
found one remaining recovery `lstat` catch that still misclassified access/I/O
failures. Round two in worker `4027f889` reuses the existing errno-aware helper
instead of that special case. Its regression produced two expected failures,
then all 64 covering tests/310 assertions passed with lint/typecheck clean. The
round-two re-review found the remaining issue addressed with no new breakage.
The fix integrated as `bbbb8e99`, completing the task gate before the final
whole-slice review below.

The preceding integrated source `a01e9994` passed `bun run check`: 3,631 core
passes, 14 qualification skips, no failures (169.26 seconds), plus 144 dashboard
passes and clean lint/typecheck. All 88 scenario checks passed. This receipt
predates the second error-classification fix and is not final verification. No
production import activates this helper or establishes container death.

Final whole-slice review found a Linux-specific P1 after the task gates: the
root post-traversal check used `lstat` on Linux's `/proc/self/fd/<fd>`
magic-link path, so unchanged roots would be rejected. A local semantic fixture
retained a real directory descriptor and supplied a symlink-addressed path; it
reproduced `source_changed` for unchanged empty roots. This is an observed local
probe, not a Linux run. The single final fix wave changes the root recheck to
bigint `fstat` on the retained descriptor while preserving descendant no-follow
checks.

The preceding source `bbbb8e99` passed the local full check: 3,634 core passes,
14 qualification skips, no failures (166.52 seconds), plus 144 dashboard passes,
lint/typecheck and 88 scenario checks. These local passes did not cover Linux
magic-link semantics and do not waive the final review finding. The final fix in
`adc7f576` (worker `8f22b83d`) passed scoped re-review with no new breakage.
Corrected semantic fixtures reproduced 35 passes/two expected failures before
the fix, then 37 final-state tests passed. The combined observer gate passed 66
tests/312 assertions with lint/typecheck clean. Final integrated `bun run check`
at `adc7f576` exited successfully: 3,636 core passes, the same 14 qualification
skips and no failures (173.27 seconds), plus 144 dashboard passes and clean
lint/typecheck. `bun run quorum check` passed all 88 checks and `git diff
--check` was clean. All task and final review findings are addressed; there are
no parked findings or additional controller rulings. These receipts supersede
the preceding source totals while retaining the negative findings and their
regressions.

The filesystem source slice is complete and remains inactive. No production
publisher path consumes it yet. The next integration joins trusted V2 binding,
candidate bytes and score to this check before the existing publication move;
actual Linux container qualification remains required. The supervisor proposal
is retired, and PRI-3097 remains In Dev for the unfinished full comparison.

## Remaining qualification gates

The [completion plan](../superpowers/plans/2026-09-05-pr2258-completion.md)
now covers all remaining source, Linux, installed, diagnostic and measured work
in one dependency sequence. Drew requested continuous execution without another
continuation prompt after each slice. Reviews and scoped fixes are internal
checkpoints; the plan retains explicit environment/credential/spending boundaries
and requests diagnostic plus conditional measured authorization in one concrete
packet. The [completion receipts](2026-09-05-pr2258-completion-receipts.md)
track execution from `00f4e03d`; no live work is implied by writing this plan.

Source tests, cross-repository Linux instrument tests, installed appliance proof,
and paid model samples are distinct. Still required after foundation work:

- Runtime source discovery/binding, complete qualified raw grammar coverage,
  portable finalization, strict scorer/readout, authenticated independent-review
  sidecars, and dialect-aware observer workflow. The offline raw-index slice above
  supplies the tested starting point for these consumers.
- Pinned-build Claude traces covering replay, compaction, split blocks and
  parent/child identity; earlier-build traces alone do not qualify a new build.
- Six-arm declarations and no-spend preflight of every credential projection,
  actual worker pricing, all-pool capacity and supported runtime settings.
- A distinct grader bearer and complete verified pricing for subjects, grader,
  cache buckets and delegates; no values or invented rates are committed here.
- A diagnostic with 3/3 valid pairs, six overlapping exposures, complete observer
  review, no invalidating skew/contention/exposure/telemetry condition, no grader
  429 latch, and reported margins.

No installed changes, credential issuance or paid execution is authorized by
this source-work record. Missing rare-case coverage requires a concrete bounded
qualification request, not automatic extra samples or a waiver into measurement.
Failed diagnostics and incomplete measured pairs remain in the record at equal
billing to successful outcomes.
