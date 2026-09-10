# Routine-use assessment corpus

This directory defines the fixed nine-case assessment qualification corpus. It keeps the original three- or four-criterion judgments, adds outcome-based atomic criteria, and requires agreement on both the complete atomic vector and its fold back to the original vector.

## Public declarations and private runtime corpus

The committed JSON files are portable semantic catalogues and materialization templates. Paths use the logical `cases/<case-id>/...` layout and contain no host-specific staging location. The known rubric and evidence-index hashes identify the selected source bytes. Empty `authenticationRefs`, empty `independentReviews`, and `independentReview: null` deliberately show that private authority has not been committed.

`loadAssessmentCorpus(root, parseRubric)` consumes a fully resolved private corpus, where `root` is the `caseRoot` bound by the operator's private manifest. That root has this shape:

```text
assessment-cases.json
rubric-mappings.json
expectations/assessment.json
rubrics/{design,code-review,debugging,verification}.md
cases/<case-id>/original-rubric.md
cases/<case-id>/evidence/index.json
cases/<case-id>/evidence/<indexed files>
authentication/<private receipts>
reviews/<independent review receipts>
```

The private materialization replaces every empty authentication/review field with a `FileRef` to authority inside the private root. The loader authenticates every referenced file, checks every evidence byte against the copy receipt, parses both rubrics through the caller-supplied Gauntlet `parseStoryCard`, and validates the fixed IDs, source kinds, mappings, criterion counts, ordinal coverage, decisive evidence membership, expected folds, and answer exclusion. It adds no Markdown parser or package dependency.

The preflight review predates the final derived files. It supports preparation and expectation provenance, but does not approve the final exact bytes. Before any provider exposure, an independent reviewer must assess the final derived rubric prose, atomic gold, decisive evidence, and source mapping. The private freeze then replaces the pending review references with the resulting exact-byte receipt and binds the complete private corpus. A candidate workspace receives only its derived rubric and the files named by its evidence index. It must not receive this README's expectations, mapping catalogue, original rubrics, authentication material, prior assessments, gold, or review receipts.

## Fixed cases

| Case | Kind | Mapping | Indexed files | Original verdicts |
| --- | --- | --- | ---: | --- |
| `claude-design` | retained live | design | 88 | fail / fail / pass |
| `known-claude-design` | retained live | design | 156 | pass / pass / pass |
| `known-codex-review` | retained live | code review | 71 | pass / pass / pass / pass |
| `codex-design` | retained live | design | 86 | fail / fail / pass |
| `known-claude-review` | retained live | code review | 271 | pass / pass / pass / fail |
| `claude-debugging-history` | retained live | debugging | 71 | pass / pass / fail |
| `codex-debugging-history` | retained live | debugging | 117 | pass / pass / pass |
| `control-e` | constructed | verification | 18 | pass / pass / pass |
| `control-f` | constructed | verification | 18 | pass / pass / fail |

The four mappings contain 10 design atoms, 6 code-review atoms, 11 debugging atoms, and 13 verification atoms. Alternatives that satisfy one obligation remain in one atom: the credential finding accepts either supported credential defect, and debugging accepts investigation or reproduction. Conjunctive groups reduce in the order fail, unclear, pass.

## Qualification and defect disposition

Qualification compares full vectors. Matching only the folded original label cannot conceal a failure on the wrong atomic obligation. Positive retained and constructed cases are frozen alongside failures, so a legitimate conditional risk or a recovered initial test failure is not changed to a failure merely to force agreement.

If independent evidence establishes a defect in an expectation or mapping, pause the affected qualification. Preserve completed results as unqualified for this decision. Identify the correction and its semantic delta separately, review both offline, then use the same single repair round and full requalification limits. Candidate disagreement alone does not establish a defect. Never promote a historical result retroactively or overwrite gold silently. A correction that materially changes the measured question returns to Drew for a decision.

## Offline candidate and private freeze

The ordinary comparison uses `suites/conversation_routine_use.yaml` and the appliance commands documented in the repository README and runbook. This dated operator qualifies the release instrument; it is not a prerequisite command for ordinary suite users.

Before paid admission, review the assembled Quorum/Gauntlet source pair and the exact derived rubric, gold, and driver-control bytes. Retain source commits, the unchanged qualified image, treatment revision, model and effort declarations, pricing digest, test receipts, input hashes, and independent review references in a private release directory. Reauthenticate original and staged evidence. The private corpus's review references bind an exact semantic review; a prior preparation review alone does not approve final bytes. Keep all expectations and review records outside model-visible evidence and workspaces.

Run the paired CLI fixtures with the assembled `GAUNTLET_ROOT`, a short private `TMPDIR`, and `OBOL_PRICING_DIR` unset, because their old fixture model uses bundled pricing. Run the three dated operator suites in a separate Bun process with this release's fixed pricing directory set before startup. Set `ROUTINE_PRIVATE_CASE_ROOT` for the separate nine-case private corpus authentication test; the portable parser tests require only `GAUNTLET_ROOT`. Then run the repository checks in both checkouts, with external-provider test opt-ins disabled. Retain failures as well as passing corrections. Source tests qualify the offline candidate; live driver and assessment fidelity still require their fixed gates.

## Finite appliance operations

`operation.ts` validates a private immutable manifest, while `run.ts` offers only `qualify --manifest <path> --role assessment|driver` and `campaign --manifest <path> --campaign-id <registered-id>`. Each manifest names the exact clean executing Quorum and Gauntlet roots/commits, private appliance config and state, corpus and output roots, round and unique operation ID, log and receipt paths, frozen input references, external admission references, and original release envelope. The caller authenticates admission-record bytes; the release coordinator supplies the independent semantic decision those records represent.

Use a separate immutable manifest, output directory, and operation identity for every invocation. Only the initial round-one assessment may bind a not-yet-created envelope by path alone. After preflight and lease acquisition, that operation exclusively creates `firstPaidAtMs` immediately before admission and records the envelope digest. Every later manifest binds those same original bytes by path and SHA-256. Never reset the clock, replace a manifest, reuse an ordinal, resume an unsettled operation, or reuse a terminal campaign identity.

On the appliance, launch the caller as a detached Linux session leader with both output streams bound to its private regular log. The output and release directories must be real private directories. The caller records actual argv, manifest digest, and process birth identity before paid admission. Retain separate detached-launch evidence and verify its identity. Verify host Bun/tmux availability and actual credential-free controlled-driver launch/cleanup before qualification; use a short output path so `<outputRoot>/<ordinal>/tmux` fits the Unix socket path limit. Preserve the existing credential projection, host spend lock, and qualified Docker image.

The fixed first round contains 18 retained assessments, 12 controlled conversations, then—only after both roles independently qualify—one registered 36-attempt campaign at global cap four. Each qualification role has 120 seconds plus two seconds for cleanup. Valid semantic misses complete the declared diagnostic set; operational, accounting, and ownership faults stop admission. A completed operation or endpoint match is not independent semantic approval.

One integrated repair is shared across qualification and fresh acceptance. Repeat each affected role's entire qualification, and repeat the whole fresh matrix under a new registered identity if a permitted fresh repair is needed. Absolute maxima are 36 assessments, 24 controlled conversations, and 72 fresh attempts. All rounds share the original six-hour observed window and $150 observed stopping threshold; pending usage is not a known final bill. The campaign observer has a ten-second read deadline, waits at most fifteen seconds between observations, and starts cancellation at the original cutoff minus sixty seconds or an earlier defined fault/threshold. A cancellation child remains owned until settlement, even when observation times out. Preserve unresolved termination and any cost or cleanup overrun in the release record.

Independent audit judges every retained atom and original fold, every controlled driver sequence, and all material rationale. Fresh attempts are audited in two stages: freeze driver fidelity and expected subject judgments with official grades hidden, then expose and assess the official judgments. Preserve automated results and unsupported pairs. Deliver to main and update canonical campaign sources only after the complete release gates; otherwise record the exact partial outcome in `results.md`.
