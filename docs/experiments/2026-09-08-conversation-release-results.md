# Conversation release: usable authoring and reports, incomplete grading and Pi

Drew authorized this bounded release under the [overnight spec](../superpowers/specs/2026-09-07-assessment-reliability-overnight-design.md) and [implementation plan](../superpowers/plans/2026-09-08-conversation-release.md). The selected release makes `quorum new` produce a conversation scenario and gives `evals-appliance campaign report` a readable terminal report with authenticated `quorum show` targets. It clarifies review criterion 3 without weakening criterion 4's whole-review grounding requirement. The existing workers, credentials, scheduler and immutable reports remain the execution path.

The grader prompt candidate and Pi support did **not** pass their live gates. Neither is included in the selected release. Twelve fresh Claude/Codex conversations completed, with usable published evidence, complete reported costs and verified termination. Independent audits found three false passes and a simulated-user deviation. This is a usable authoring and reporting increment, not a completed reliable eval product.

## Frozen sources and selection

| Component | Revision |
| --- | --- |
| Quorum baseline | `debc8011ec442f249766bfbeb01aace01f12e2cb` |
| Combined experimental Quorum used for replay and Pi | `b9f77eba63439074da593224fd441b7c839df52b` |
| Selected Quorum runtime, used for all twelve acceptance cells | `ed59fc905b62d8f195fbc9e06e9e5dc905fea37b` |
| Selected baseline Gauntlet | `6dac4bfcb16042cb277067bb4535f9f22b9bb5df` |
| Unpromoted Gauntlet prompt candidate | `72a1ad01a5de09dafcbe56ee6ae216eb5f841783` |
| Superpowers | `b36e0829c6d0140e93cfef2ca599b1b07d4a7797` |
| Installed runtime image | `sha256:2ee3e07dff9f2bb98d2e427da98ec73ab6efc077f4561f516b0a6130d0478d4e` |

Selection starts from main and includes only the independently reviewed authoring, terminal readout, rubric clarification, corpus and documentation. All 95 included changed files match the reviewed experimental revision byte for byte; all 13 excluded Pi/operator paths match baseline or are absent. Only five production modules change: scaffold, appliance CLI/renderer, CLI entry and cost wording. Pi admission, Pi suites and the dated replay operator stay on the preserved experiment branch. No Gauntlet change is selected.

## Retained assessment: stopped, candidate unpromoted

Before paid calls, independent reviewers agreed on all 34 criterion expectations across four real retained cases and six constructed controls. The original review rubric and results remain intact. Drew's explicit clarification makes C3 judge whether supported required defects justify withholding merge approval; C4 still judges every material claim. Both assessor versions received identical derived rubrics and indexed evidence. This replays a clarified rubric, rather than reproducing the original grades.

The [frozen corpus](2026-09-08-conversation-release/README.md) has payload digest `f4655b238a786610b57ed668b9cdb59261c9a4f940ed32739b149485c8c1cb1c`. All 657 corpus/original artifacts were verified on the appliance. Sixteen known-case rows and twenty-four conditional control rows were frozen before launch. The prompt implementer did not inspect the separate control contents before freezing the candidate.

Replay began at `2026-09-08T08:50:32.568546Z` and stopped after two known-case calls at `08:53:29.436Z`:

1. Baseline produced a valid all-pass Claude review report. Its C4 judgment was a false pass: the review asserted an unconditional authentication bypass despite the missing database-driver/result contract. The assessor had read the decisive capture.
2. Candidate made four invalid `report_result` submissions, each missing required top-level `reasoning`, then reached the external two-minute deadline. It produced no accepted report or valid criterion vector. The validator correctly rejected the malformed submissions.

Fourteen remaining known-case calls and all twenty-four controls were not run. There was no retry, second candidate or tuning after results. The evidence does not establish whether the prompt, model or upstream serialization caused the malformed arguments. No prompt improvement was demonstrated. The operator and owned assessment processes stopped and released the shared spend lease.

## Pi qualification: startup and publication failures

Campaign `172b0629-d288-4f4f-a0b3-86156398c6c1` attempted pricing once using `pi_gpt56_sol`, without an effort field. Pi 0.80.7 failed before creating a native session: its default session-directory encoding turned the 294-byte campaign working directory into one 297-byte filename component, producing `ENAMETOOLONG`. This is the component-length limit, not total path length. Quorum relied on the default directory; offline tests wrote fixture sessions directly and missed installed startup behavior.

The attempt then hit a separate failure-publication defect. An unused empty `gauntlet-agent/results` directory was rejected as an unlisted artifact before rename. All 75 listed files and hashes matched. The report therefore retains an indeterminate outcome, incomplete costs and no authenticated attempt artifact references, with termination verified. The original failure evidence remains in private staging. This shared failure path is not established to be Pi-specific, and the terminal renderer accurately displays the upstream missingness.

The second Pi qualification was not launched. Pi remains unqualified for conversation mode; its runtime and suite changes are unpromoted. No failure-path publication change was made under this release's frozen publication boundary.

## Twelve fresh acceptance conversations

The predeclared fallback used existing `conversation_broad_signal`: six task families on Linux Claude/Opus 5 (`opus5_bedrock`) and Codex/Sol (`openai_responses_56sol`), high effort, one attempt each, no reserves or replacements. Both evaluation roles used Sonnet 5 through the frozen Mantle credential. Campaign `689b43ac-8088-4e1c-93f1-58268561cae9` ran from `09:13:14.642Z` to `09:28:20.126Z`, **905.484 seconds** at global cap four.

All twelve delivered work and published native/visible transcripts, outputs, checks, fresh assessments and priced usage. Each owned container was independently inspected stopped; launcher/controller processes were absent and the shared spend lease was released. Container intervals show a peak of four, peaks of four within each harness, and cross-harness overlap. This is observed concurrency in one finite batch, not sustained capacity or an old/new speed comparison.

Auditors received authenticated rubric/evidence copies with official grades excluded. Their criterion judgments were saved and hashed before grade exposure. The independent column below preserves those judgments; original official results were not rewritten.

| Scenario | Claude official / independent | Codex official / independent |
| --- | --- | --- |
| Code review | PASS / FAIL | PASS / PASS |
| Debugging | PASS / FAIL | PASS / PASS |
| Design | PASS / FAIL | PASS / PASS |
| Pricing | PASS / PASS | PASS / PASS |
| Review feedback | PASS / PASS | FAIL / FAIL, attribution caveat |
| Verification | PASS / PASS | PASS / PASS |

The three false passes have distinct causes:

- **Claude review:** required defects were found and withholding approval was supported, but delivered material claims exceeded available evidence. This fails C4, not clarified C3. A local import check or synthetic JavaScript truthiness test does not establish unconditional authentication bypass or all execution history.
- **Claude debugging:** the implementation and verification were correct, but the final account falsely said the other two original content tests had passed. The recorded pre-fix uneven-input assertion had failed. This fails accurate test-history reporting, not implementation correctness.
- **Claude design:** the conversation and proposal omitted choosing tasks to watch and connecting that choice to notices. A completion-toast/undo proposal does not supply the missing watch selection. The original page remained unchanged, satisfying the no-implementation boundary.

The Codex feedback failure is retained as completed bad work, but is not clean evidence of unprompted subject behavior. The simulated user explicitly demanded switching to `time.time()` despite a brief requiring neutral answers. The coding agent had already proposed that clock choice; the subsequent driver instruction still violates the intended experiment. Its wall-clock implementation fails the trusted boundary check. The official assessor also treats an authentic local `3 passed` result as unsupported because the separate oracle failed. Those are different tests; our independent F4 failure concerns the missing requested explanation for declining the clock suggestion. A correct overall fail does not validate misleading reasoning or erase driver contamination.

Codex design incorporated watch selection, but the driver volunteered it while answering the channel question. That establishes incorporation, not independent elicitation. Codex verification correctly passed, but the assessor cited post-commit tests as proof of pre-commit verification; separate earlier receipts support the criterion. These observations make aggregate model rankings inappropriate for this batch and show why matching grades alone are insufficient.

## Costs and evidence access

| Stream | Observed priced amount | Coverage and disposition |
| --- | ---: | --- |
| Retained assessment | $0.6339869 | Retained usage only; interrupted candidate request billing unverified |
| Pi qualification | $0.0229260 | Driver usage retained privately; canonical publication/cost coverage incomplete |
| Fresh acceptance | $15.1614338 | 12/12 complete reported subject and evaluation-role coverage |
| Known total | **$15.8183467** | Not reconciled total billing because stopped streams have missingness |

Acceptance subject cost is $7.9486068 and combined driver/assessor cost is $7.2128270. Per-role receipts are approximately $5.911260 for conversation and $1.301568 for assessment; tiny differences from the combined subtotal reflect pricing rounding. Frozen pricing is dated September 6. Costs from previous pilots are not included. The separate $12/$6/$22 allocations were not transferred or exhausted; no further provider calls are authorized by this result.

Ordinary reports remain on the appliance. From the configured pilot helper:

```bash
/srv/quorum/pilots/conversation-assessment/bin/evals-appliance campaign report 689b43ac-8088-4e1c-93f1-58268561cae9
/srv/quorum/pilots/conversation-assessment/bin/evals-appliance campaign costs 689b43ac-8088-4e1c-93f1-58268561cae9 --json
```

The terminal report exposes all twelve scenario/arm headings and twelve exact authenticated `quorum show` targets. Root verified their verdict hashes against the report anchor and executed every command successfully on the machine holding the results. Each drilldown separates completed conversation from grade and presents role costs. This verifies faithful presentation of the existing report, not the truth of every LLM judgment it contains.

Private operator receipts and copied evidence are under `results/conversation-release/` in the preserved `conversation-assessment` worktree; auditor judgments and comparison reports are under `.superpowers/sdd/2026-09-08-conversation-release/`. Their counterparts live under `/srv/quorum/pilots/conversation-assessment/conversation-release/`; published run evidence is under `/srv/quorum/pilots/conversation-assessment/results/`. Raw transcripts and homes are not committed. The frozen corpus README remains a pre-run record; this document records subsequent outcomes.

## Verification and remaining work

Selected runtime `ed59fc90` passed the required full check: **3,706 core tests passed, 20 skipped, zero failed**, plus **144 dashboard tests passed**, lint and typechecks. Scenario validation passed. Five actual baseline-Gauntlet CLI outcomes over tmux and a scripted localhost provider passed 162 assertions; those tests made no live provider calls. Every implementation and the combined release received independent review; one combined correction wave and scoped rereview resolved the three final findings. A prior direct one-second fixture timeout remains unexplained; the normal full suite and actual paired CLI checks passed without changing deadlines.

The prompt candidate separately passed source checks and 1,348 tests with two provider-gated skips, but its live gate failed. Pi's offline fixtures passed but its installed startup failed. Those distinctions determine promotion.

Next work should stay at the observed boundaries: exercise Pi's supported explicit private session directory from a deep campaign path; reconcile empty generated directories with failure publication; diagnose malformed tool arguments without weakening validation; and correct simulated-user instruction adherence and assessor evidence reasoning using preserved cases. Broader harness coverage and migration of existing QA scenarios remain unfinished. No scheduler replacement, generic eval layer or second prompt experiment was introduced to make this release look complete.

## Runtime integration and installation

Selected runtime `ed59fc905b62d8f195fbc9e06e9e5dc905fea37b` was integrated directly to main, without a PR or force push, under Drew's instruction. GitHub reported the maintainer exception to PR/expected-status branch rules; no local hook was disabled. Its [test/scenario workflow](https://github.com/prime-radiant-inc/superpowers-evals/actions/runs/34211237774) and [CodeQL workflow](https://github.com/prime-radiant-inc/superpowers-evals/actions/runs/34211236685) passed.

Canonical helper prepare job `job-20260908T094035Z-ec44` installed that Quorum revision with baseline Gauntlet `6dac4bfcb16042cb277067bb4535f9f22b9bb5df`, pinned Superpowers and the unchanged image listed above. At `09:41:34.958408Z`, independent source/doctor verification found both checkouts clean at those revisions, ordinary and shared spend locks absent, and only the base appliance container running. The subsequent documentation commit records these outcomes without changing the verified runtime. The coordinator checks final documentation/main CI and installation separately and stores those receipts in the private release directory.
