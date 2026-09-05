# Task 8 review fix round 1

Status: DONE_WITH_CONCERNS — both accepted Important findings implemented and locally verified; independent fix review pending. Existing Task 9 and platform evidence obligations remain outstanding.

Review base: `6c9de8229f68dd8c9851fb89bca190f065ad58ed`.
Source commits:

- `15b691f6c2fde65305d1e2d9620909fb316aef64` — bind sealing to canonical report derived from the exact prefix (I-1).
- `ca888c5e1129b8454fb859b3b8554d81fdefa769` — preserve named comparison roles in JSON and Markdown (I-2).

The full `task-8-review.md` was read and both concrete root causes were confirmed before regression-first fixes. All source writes stayed in the approved core-comparison worktree on `codex/core-comparison`; only requested synthetic preview files and local test logs were written outside it. No root-owned plan/spec/checkpoint edits, subagents, Task 9 implementation, Docker, live/provider/credential, remote/appliance/installed actions, historical artifact mutation, migration, push or merge occurred. Commits used explicit paths and normal hooks.

## I-1: caller measurements and incomplete inventory could seal

Root cause: the seal checked terminal prefix identity, then authenticated only the caller's listed artifact inventory and published caller measurements. Shape validation did not bind a finite subtotal, completeness claim, or artifact list to the authenticated projection.

The existing prefix-to-readout derivation was extracted into `readComparisonFromPrefix({campaignDir,resultsRoot,prefix,interrupted?}): Report` in `src/campaign/report-publication.ts`. `prefix` has the existing `ReturnType<typeof readCommittedPrefix>` shape. This helper requires explicit absolute roots and reuses the existing attempt evidence reader, positive block validity reader, pure comparison fold, and code-unit-sorted/deduplicated anchor construction. It adds no journal read, lifecycle read, fold, verifier framework, runtime policy, pricing engine or artifact service.

`readComparisonReadout` still reads its measurement prefix once and establishes the exact-prefix interruption decision before invoking this helper. `sealReport` reads one committed prefix, verifies it is the exact completed/terminated prefix claimed by the caller, derives the canonical report and complete anchor from that same prefix, then compares canonical JSON bytes. A mismatch fails before report or seal publication. It authenticates every reference in the derived anchor with the existing raw-byte helper, then publishes the derived report and seal anchor. Inventory equality alone is not relied upon. Corrupted termination bytes still fail the raw-byte check; binary manifest artifacts remain byte-authenticated without UTF-8 interpretation.

Regressions use actual temporary journals, real manifest/publication producers, and frozen fake process proofs. They first assert that each edited report remains schema-valid, then reject sealing and verify that report/seal files were not created:

- finite subject known subtotal increased by 100;
- subject evidence cost completeness changed;
- accounting completeness/observed-count changed while locally shape-valid;
- termination reference omitted;
- all result/attempt references omitted;
- full artifact inventory emptied.

A further case keeps an authenticated but wrong-block positive validity receipt: canonical analytical completeness is false; forging `complete: true` cannot seal. The unchanged canonical completed report seals twice idempotently, preserving exact canonical bytes and digest. Existing corrupt-control-byte and exact-prefix advancement regressions remain covered. The fixture completion sequence was extracted without changing producer behavior.

## I-2: named roles missing from the exported contract

Root cause: the fold correctly used frozen baseline/treatment identities for matching, but omitted those identities from the report. Cell arm row order is allowed to differ from role order, making anonymous means/deltas ambiguous to standalone consumers.

`ComparisonRolesSchema` is a strict union of `{baseline: string, treatment: string}` and `{arm: string}`. Each comparison requires `roles`, copied directly from the frozen Experiment mapping. Its exact arm inventory must match that mapping, with distinct paired names and no duplicate arm rows. Single arms must have zero pairs. This is a correction to the preacceptance report contract, without runtime compatibility or a second schema selector.

Markdown derives role labels only from this strict JSON: an explicit named comparison sentence, a role column on arm rows, and named baseline mean, treatment mean, and treatment-minus-baseline delta headers. Single-arm JSON uses `{arm}` and Markdown explicitly names that arm and omits the paired table.

A `variant-a` baseline / `variant-b` treatment regression reverses `cell.arms` to treatment first. The rows retain that order, the roles remain correct, and the literal pass means/delta are 0 / 1 / +1; subject USD means/delta are 1 / 4 / +3. The single-arm case and missing/foreign/duplicate/extra-field role mappings are covered. The fixed twelve-attempt oracle received only explicit role mappings, with no generated or changed numerical expectations.

## RED/GREEN commands and receipts

I-1 RED:

```sh
bun test test/campaign-comparison-publication.test.ts
```

`/tmp/task8-fix1-i1-red.log`: **7 pass, 6 fail, 52 assertions, 13 tests**. The six tampered-report tests reached the expected rejection assertion and failed because the old implementation accepted sealing.

I-1 committed GREEN:

```sh
bun test test/campaign-comparison-publication.test.ts test/campaign-comparison-evidence.test.ts test/campaign-comparison-contract.test.ts
```

`/tmp/task8-fix1-i1-gate.log`: **28 pass, 0 fail, 136 assertions, 3 files**. Lint/typecheck/diff whitespace checks also passed before the I-1 commit.

I-2 RED:

```sh
bun test test/campaign-comparison-report.test.ts
```

`/tmp/task8-fix1-i2-red.log`: **8 pass, 2 fail, 28 assertions, 10 tests**. Named roles and explicit single-arm mapping were undefined in production output.

I-2 initial GREEN:

```sh
bun test test/campaign-comparison-report.test.ts test/campaign-comparison-contract.test.ts test/campaign-comparison-publication.test.ts
```

`/tmp/task8-fix1-i2-green.log`: **27 pass, 0 fail, 116 assertions, 3 files**. The final strict role rejection test was added before the complete affected gate below.

Final affected gate after both source fixes:

```sh
bun test test/campaign-comparison-publication.test.ts test/campaign-comparison-report.test.ts test/campaign-comparison-evidence.test.ts test/campaign-comparison-contract.test.ts test/campaign-execution-state.test.ts test/campaign-cancellation.test.ts
bun run lint
bun run typecheck
git diff --check
```

`/tmp/task8-fix1-final-tests.log`: **101 pass, 0 fail, 448 assertions, 6 files, 2.66 seconds**. Lint: **558 files checked, no fixes/errors**; typecheck and diff whitespace check: **exit 0**. No timeout was raised. These checks cover the touched report/read/seal/strict-contract interfaces and adjacent shared projection/status contracts; the full repository gate remains Task 9.

## Refreshed synthetic preview and independent inspection

```sh
bun /tmp/task8-render.ts > /tmp/task8-rendered-inspection.json
```

Refreshed `/tmp/task8-rendered/report.json` and `/tmp/task8-rendered/report.md`. The preview uses the checked-in twelve-attempt fixture and now explicitly includes the caveat: “Synthetic fixture preview only; this is not live campaign evidence.” That preview-only caveat exists in both JSON and Markdown and was not added to the production fold. Its fixture prefix remains sequence 26, SHA-256 `5f446cf0c41fc43d1487765cad7aae00c8f445ca6e3376de4aef9ccaba9f6db0`. No live publication or seal is claimed for this pure fixture preview.

Read the full refreshed Markdown: C1 labels baseline b and treatment t1; C2 labels baseline b and treatment t2. Both arm rows and paired mean/delta headings identify those names. Counts, matched cohort sizes, missing means, accounting coverage, excluded accounting, all 12 attempt rows and fixture references were inspected. The role-order regression separately verifies arbitrary variant names and single-arm rendering.

An independent Python Decimal script used the twelve literal rows, with no production imports. It asserted subject **136 at 9/12**, grader **5.9 at 11/12**, combined **141.9 at 9/12**, and wall **500 at 10/12**, all incomplete. It checked all literal planned outcome counts, C1 paired pass .5/1/+ .5, subject 1/2/+1 (n=1), grader .55/.30/-.25 (n=2), wall 55/30/-25 (n=2), corresponding C2 means/deltas, 12 attempts, named Markdown labels, and explicit synthetic context. Result: **PASS**. It also loaded `expected-report.json` from the review base with `git show`, removed only the new roles from the current expected JSON, and asserted exact equality: all prior numerical oracle data is unchanged.

## Self-review and remaining boundaries

Reviewed the fix diff and the complete seal flow: no caller measurement reaches publication unless canonical byte comparison succeeds, inventory comes from the exact same committed prefix, and raw bytes are reauthenticated before publication. The existing no-follow roots, positive validity receipt checks, shared `isValidSidecarLine` predicate, active behavior hiding, and exact-prefix process-loss guard remain intact. The role mapping comes from immutable Experiment identity and never infers roles from row order. Existing canonical JSON, immutable durable publication, and shared fold/evidence primitives remain single.

Task 9's temporary Budgeted modules/imports and public/helper cutover inventory remain exactly as documented in `task-8-report.md`. Unsupported subject lifecycle/provider-error reporting and resume/restart remain deferred. Task 7's **99 pass / 2 timeouts** remains unresolved, was not rerun, and is neither claimed green nor attributed to baseline. No Linux/appliance/installed/provider/live qualification was attempted. The fresh scoped independent review is still required before Task 8 acceptance.
