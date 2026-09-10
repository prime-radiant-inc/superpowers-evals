# 2026-09-09 PR 2236 session-discovery pilot

For the current combined recommendation, see the
[Claude absolute-path follow-up](2026-09-09-pr2236-claude-absolute-path.md#review-recommendation).
The original six-attempt record below is preserved; the Pi and Claude
follow-ups are separate observations.

**Status:** Executed once and independently assessed. Claude and Codex recovered
the correct history and supported facts before and after the reference removal.
Claude's abbreviated paths failed the frozen absolute-path requirement. Both Pi
attempts failed during startup, before subject exposure. The all-three-harness
success condition is therefore **not established**. The campaign is stopped;
there were no replacement evaluations. Known pilot cost is **$2.86248395** after
recovering Pi's grader usage; Pi subject usage remains missing.

The operational allowance was **$25 all-in**, selected after the operator
delegated that choice on 2026-09-09. It was not a platform-enforced ceiling.

## Question and hypotheses

This feasibility pilot asks whether the shared discovery procedure in the PR
2236 treatment can locate and interpret one ordinary remembered native session
on Claude, Codex, and Pi without the control's harness-specific Superpowers
references.

The preregistered success condition is that the treatment returns the required
identity, path, recovered request, tool action/result, and supporting source
locations on all three harnesses, with no unresolved critical error or
unexplained loss against its paired control. Failures remain visible. A setup,
exposure, capture, or assessment failure makes that cell inconclusive and does
not authorize an automatic retry.

One observation per arm and harness can demonstrate examples and expose obvious
regressions. It cannot estimate a reliability rate, establish equivalence, or
qualify archived, relocated, ambiguous, current-session, unavailable, large, or
incomplete-history cases. Additional cases and repetitions are deferred until
the six-run readout is reviewed.

## Frozen execution

The first execution is exactly one discovery scenario × three harnesses × two
arms × one repetition: six planned evaluations in three paired blocks. There is
no reserve, retry, separate paid qualification batch, or fixture-generation
call. The controller admits paired arms rather than running every control before
every treatment, with a global launch cap of two.

Configuration: `suites/pr2236_session_discovery.yaml` with
`reserve: 0`, `max_exposure_skew: 60`, `max_attempts: 1`, and an outer
`max_time_s: 600`. The scenario's `quorum_max_time` is `8m`, leaving two minutes
for startup, final capture, and checks. Grading uses credential `sonnet5`, model
`claude-sonnet-5`.

| Block | Harness | Control arm | Treatment arm | Scenario | n |
|---:|---|---|---|---|---:|
| 1 | Claude | `pr2236_claude_before` | `pr2236_claude_after` | `diagnosing-session-discovery` | 1 |
| 2 | Codex | `pr2236_codex_before` | `pr2236_codex_after` | `diagnosing-session-discovery` | 1 |
| 3 | Pi | `pr2236_pi_before` | `pr2236_pi_after` | `diagnosing-session-discovery` | 1 |

The runtime/model choices are controlled initial settings, not a model ranking:

| Harness | Credential / model | Arm effort | Pinned CLI |
|---|---|---|---|
| Claude | `opus_bedrock` / `anthropic.claude-opus-4-8` | `high` | Claude Code 2.1.209 |
| Codex | `openai_responses_56sol` / `gpt-5.6-sol` | `high` | Codex CLI 0.146.0 |
| Pi | `pi_gpt56_sol` / `gpt-5.6-sol` | omitted | Pi 0.80.7 |

Pi's runtime configuration requests thinking `medium`, but this credential's
installed model declaration has no reasoning capability. Pi 0.80.7 therefore
clamps the effective harness setting to `off`; the arms intentionally omit the
unsupported effort field.

## Source and runtime package provenance

Both packages use the same export policy: tracked top-level `docs/`, `tests/`,
and Git history are absent, while retained runtime bytes, modes, safe symlinks,
manifests, hooks, and skill files are preserved. The private receipt named below
is the exact sorted installed regular-file path/SHA-256 manifest; its digest
binds the full inventory without publishing removed reference content.

| Arm role | Normative source SHA | Runtime package SHA | Files | Receipt | Receipt SHA-256 |
|---|---|---|---:|---|---|
| Control | `801badbf719f4044c97175e5b01fb6f7cbc32c2d` | `d7bc5b0197d3f5358d8af03d4474ec3c826465be` | 113 | `control/receipt.json` | `836d6b203c4706e3c98ad7162f64250e6e67319b8df02ab34fa3630b431ad69f` |
| Treatment | `bc256ce4228ab8d74f963d8391eed529ba8c0fd2` | `1a51aa0ac628f75354fd3e1a52b572b603953c77` | 111 | `treatment/receipt.json` | `9a4a521cd5bb58dce3c343fd280607f03d43f41e36a6a26e51f743d9837f3f61` |

The control is the PR head, not the PR base. The treatment is its reviewed
derivative with the shared discovery instruction. Runnable arms use only the
full runtime SHAs above. The selected Evals code commit is
`7ed4d649a05f83df5d5f9f9e48ebdb864ec906c1`. This metadata-only record follows
that commit; the isolated appliance checkout selects the named code commit,
which contains all implementation, configuration, and test corrections.

The inspected execution image is
`sha256:01fb1cd08f1e31c82fccedbaadead09e6ff97bca1f5d66f2f0904728ad536e8c`.
It contains Quorum 0.1.0, Bun 1.3.14, and obol 0.9.0. Gauntlet is pinned to
`256feaea65ea0016dec4133f2cd031bd72be8754`. The prelaunch check and all six
recorded runtime intents match this immutable image digest. The final journal prefix matches the report anchor. Costs below
are estimates with pricing and coverage provenance; old introductory-price
comments are not billing guarantees.

## Fixture provenance and exposure boundary

Each harness gets exactly three curated native JSONL histories in its normal
log directory in a fresh provisioned home/config: one discoverable remembered
conversation and two plausible alternatives. Both arms in a harness receive
byte-identical histories. No original profile, database, history index, source
Git history, private provenance, or answer key is mounted. This minimal native
file store establishes readable file inputs for the selected task; it does not
qualify every session-list API or storage mode.

The public, role-free source manifest is:

| Harness | Fixture path | SHA-256 |
|---|---|---|
| Claude | `history/claude/-workspace-session-discovery-project/1020a1f2-c010-594b-97e8-2100f1d3a7ce.jsonl` | `4f869a999369ce22f4354e0266efe0cc4b2f753efd739b2653a24da417c517a9` |
| Claude | `history/claude/-workspace-session-discovery-project/8c45254a-d3bf-4055-8f7b-4e780c1f0e96.jsonl` | `aa289b428abe43397289ca6b2e0b01e98f4e4cd4583b0ce463739148970a268e` |
| Claude | `history/claude/-workspace-session-discovery-project/cfe07097-04b7-5d94-8a8e-43ab3c11664f.jsonl` | `64388d68a76095c1848a2f5ad212665b65ef0e1b70b9657df818f0ead012ed68` |
| Codex | `history/codex/2026/06/01/rollout-2026-06-01T14-45-26-5d9889ae-f9b2-533b-bb1b-bd98aa1cbd0a.jsonl` | `3e3d4074b0ba6e42e79f0a5a938ac90628f9156238cca1356fe9fdf9191886e7` |
| Codex | `history/codex/2026/06/02/rollout-2026-06-02T14-45-26-019e8a4c-710f-7e12-ba18-cc4f2e5cd871.jsonl` | `dac3341aa20bf5e023cd69a62d6ab16335d7423180d221f1eaab7d42f90a7a3e` |
| Codex | `history/codex/2026/06/02/rollout-2026-06-02T14-45-26-a14f10e3-7860-544a-b714-36d2a7bba207.jsonl` | `2ae813e9484ae19b9ba4484d3b4f3d1b5ccf4affd97d12381243c9ade499bb3c` |
| Pi | `history/pi/--workspace-session-discovery-project--/2026-08-04T23-49-46-341Z_66d9efa5-435b-59d1-bbf9-d20209ca8a23.jsonl` | `08de681c12035a0dd69d84b6fc5d5120fc5fb8bfa8630aab643ff9580bfb9baa` |
| Pi | `history/pi/--workspace-session-discovery-project--/2026-08-05T23-49-46-341Z_019fd455-46e5-73cb-b2c8-94b03f7fb379.jsonl` | `9d4567e84ebf23b728b2e985b8017146e016b5daa7842d0aa1c222c69b4b5445` |
| Pi | `history/pi/--workspace-session-discovery-project--/2026-08-05T23-49-46-341Z_82e32eb9-87c1-55ae-86ae-45ef69003f8c.jsonl` | `a6e571aca8be08ba5dbb6f267554133c986826fd29997a9fb9f8f642d6bf8da2` |

Private operator artifacts are retained outside every subject mount and bound
before measurement by these hashes:

| Artifact | SHA-256 |
|---|---|
| `fixture-provenance.json` | `48171e624562e21a812534fc57f6b7199c051173bef750fb04e28361fe1616d9` |
| `frozen-fixture-inputs.json` | `e83dde0f188c9fb99d7ef47dbe5de84d6d740824c7d51ff183d7a7f67763259b` |
| `public-cues.json` | `55a3312c0d61235f237eb09c3a73face38b8809f884448ace374709f0514b797` |
| Claude answer key | `55dc68def7b11d8be525fdaaf7b3876b8691dc81bae83155fd6462189896a30e` |
| Codex answer key | `43e006934c1de2019eac0dcbbc45c5e31714a4111ccf01434e8f827b4393535e` |
| Pi answer key | `109058c15f6bb0e7f30623d763b959b6b5594a07293cd931ab4f56b76aec3465` |

Fixture-generation calls: **0**. The corpus came from retained native histories,
with operator paths sanitized and alternatives explicitly constructed; raw
sources, target/alternative roles, expected facts, keys, and access details
remain private.

## Exact public interaction

The driver sends exactly one of these messages according to the harness.

Claude:

> On June 5, 2026, around 17:00 UTC, I asked you to create hello.txt containing
> the word hi. Please find that earlier conversation and establish what the
> file-writing tool did and whether it succeeded.
>
> Use diagnosing-superpowers only to locate and inspect the session. Give me the
> session id and path, what I asked, and the tool action and result that establish
> the answer, with source locations. Stop there without running the full
> diagnosis.

Codex:

> On June 2, 2026, around 21:45 UTC, I asked you to create hello.txt containing
> hi with no other content. Please find that earlier conversation and establish
> what the tool verification showed about its exact bytes.
>
> Use diagnosing-superpowers only to locate and inspect the session. Give me the
> session id and path, what I asked, and the tool action and result that establish
> the answer, with source locations. Stop there without running the full
> diagnosis.

Pi:

> On August 5, 2026, around 23:50 UTC, I asked for a minimal Express
> authentication POC with JWT tokens expiring after 24 hours. Please find that
> earlier conversation and establish what the existing health route returned when
> you inspected app.js.
>
> Use diagnosing-superpowers only to locate and inspect the session. Give me the
> session id and path, what I asked, and the tool action and result that establish
> the answer, with source locations. Stop there without running the full
> diagnosis.

If the Coding-Agent asks for identifying information, the driver replies once,
exactly: `Use the cue and time window in my request.` It supplies no path, id,
expected result, record-format hint, parser, candidate, correctness signal, or
request to keep trying. The run stops after the discovery result or a specific
delivery limitation.

## Independent assessment

Quorum's deterministic post-check confirms exposure and retains the installed
histories; the Gauntlet-Agent's self-grade is conversation evidence, not the
discovery oracle. After each attempt, the operator creates a separate private
assessment directory with a hash-verified copy of the frozen key for that
harness. Separate directories prevent the assessment sidecars from one arm
overwriting the other arm's evidence.

The assessment records mechanical identity/path/request/fact/citation checks,
then independently audits extraction faithfulness, semantic entailment, native
root attribution, uncertainty, exposure, source preservation, bounded reads,
and contamination against raw retained evidence. The mechanical `passed` field,
manual semantic audit, and Gauntlet self-grade remain separate findings. Any
disagreement is reported rather than resolved by majority vote.

Offline preparation in the pinned Linux image passed the fixture, evidence, and
package tests: 37 tests, 202 assertions, no failures, with networking disabled
and no credentials mounted. This exercised all three real setup, capture, usage,
post-check, and attribution paths. The installed Pi 0.80.7 native reader opened
all three Pi files. Package inspection verified all 113/111 receipt hashes,
absent development trees, expected reference inventory, inaccessible source
history, and no removed-reference filename in the bare image. These checks show
the prepared inputs are readable and isolated; actual treatment access and
semantic correctness still require the per-attempt audit.

Final verification of the selected source passed `bun run check`: 3,612 runner
tests and 144 dashboard tests passed, 15 platform tests were skipped, and lint
and typechecking passed. Full `bun run quorum check` passed. The initial
aggregate check caught a missing entry in the existing intentional-harness-pin
allowlist; the selected code includes that reviewed correction and the passing
aggregate rerun. An earlier review also corrected invalid subject paths being
misclassified as assessor errors. Both failures and their fixes remain in the
private preparation evidence.

The pinned Linux image passed the final configuration test (43 assertions).
Offline registration compilation against the selected committed source produced
exactly six eligible slots, no exclusions or reserve slots, feasible credential
pools, global cap two, and a 600-second outer bound. The image digest was
rechecked against the value above. These operations did not register or launch
a campaign. Private evidence includes `final-check-rerun.log`,
`final-quorum-check.log`, `linux-config-test.log`, and
`admission-final-code.json`.

## Six-attempt readout

Campaign: `b3f8c734-1207-443e-8982-1174fea79af8`, input digest
`f81e1488123ac9dac5cb3c3334491a60e6aa90543a619f2d9de813923919b1bc`.
The installed isolated appliance helper launched the registered suite once over
Tailscale SSH. Campaign elapsed time was **414.374 seconds**
(`2026-09-09T23:37:59.573Z` to `23:44:53.947Z`). Final state is `completed`,
termination is verified, and the report correctly retains `complete: false`
because Pi supplied no usable behavioral result.

| Harness | Arm | Quorum | Frozen mechanical checks | Independent discovery assessment |
|---|---|---|---|---|
| Claude | before | pass | 4/6; fail retained | Correct history and facts; abbreviated path |
| Claude | after | pass | 4/6; fail retained | Correct history and facts; abbreviated path |
| Codex | before | pass | 5/6; fail retained | Correct history, absolute path, request and tool evidence |
| Codex | after | pass | 5/6; fail retained | Correct history, absolute path, request and tool evidence |
| Pi | before | indeterminate | Not assessable | Inconclusive: startup failed before input |
| Pi | after | indeterminate | Not assessable | Inconclusive: startup failed before input |

The independent reading agrees on the substantive discovery result in all four
exposed attempts. Both treatments loaded `session-discovery.md` and discovered
their native store without reading a removed harness-specific reference. All
four loaded the diagnosing skill before discovery, checked candidate sizes,
distinguished the remembered request from competing histories, matched tool
calls to results, and stopped before full diagnosis. No extra identifying hint,
analyst dispatch, external fetch, private-key access, or subject file write was
observed. All three retained histories in each of the four captured runs match
the frozen corpus hashes.

The strict results have two distinct explanations, both retained without
changing the checker or keys after observation:

- Claude before reports `~/.claude/...`; Claude after reports
  `<HOME>/.claude/...`. These identify the correct home-relative file, and the
  traces show access under the correct isolated home. Neither is the absolute
  source path the frozen checker requires. This is a reporting shortcoming in
  both variants, not a wrong-session discovery.
- The citation allowlist is too narrow for ordinary correct answers. All four
  outputs include valid source citations omitted from the key: session metadata,
  an assistant summary explicitly labeled as such, or a rejected alternative.
  Codex before also cites the native `user_message` event containing the same
  human text and timestamp as the key's `response_item` message. Every retained
  citation exists and was manually checked for its claim, but the exact
  allowlist rejects it. The extraction retains these citations rather than
  dropping them to obtain a pass. This is an assessment limitation; the frozen
  `citation-relevance` failures remain visible.

There is no observed loss of session identification or factual correctness after
reference removal in Claude or Codex. This is evidence of feasibility on two
ordinary examples, not equivalence or a reliability estimate. Some projections
of selected small tool/metadata objects lack an explicit 500-character clamp;
the pilot does not establish safe handling of large histories.

Initial review used opaque attempt labels, but real paths and skill references
revealed the condition during reading. The assessment was independent of the
Gauntlet-Agent's self-grade; it was **not fully blinded**.

### Pi startup failure

Both terminal captures show Node `ENAMETOOLONG` in Pi's
`getDefaultSessionDir` / `SessionManager.create`. Pi encodes the entire current
working-directory path into one directory component. Here those components were
**291 bytes before** and **290 bytes after**, exceeding the filesystem's
255-byte component limit. No Pi session or input turn started. The native-file
reader qualification did not exercise session creation at the full campaign
staging path, so it did not catch this integration failure.

The Gauntlet-Agent invoked the same failing launcher twice inside each Pi
attempt. These startup retries are retained as a protocol deviation, not counted
as new successful exposures. There were exactly six campaign attempts, no
reserve admissions, no replacement campaign, and no subsequent paid run. Pi's
missing transcript also prevented post-stop history collection and frozen usage
composition. Its discovery behavior cannot be graded from these artifacts.

### Time, tools, and cost

Discovery seconds measure the retained opening human message through the final
Coding-Agent answer, excluding earlier startup and later grader work. Tool calls
count recorded subject invocations, including skill reads; different harness
interfaces make these counts descriptive rather than directly interchangeable.
Subject token totals include cache reads/writes and exclude seeded historical
usage. Pi has no subject measurement.

| Harness | Arm | Discovery seconds | Tool calls | Subject tokens | Subject USD | Grader USD |
|---|---|---:|---:|---:|---:|---:|
| Claude | before | 56.179 | 10 | 315,854 | 0.49313600 | 0.32361120 |
| Claude | after | 60.661 | 11 | 322,631 | 0.48451475 | 0.32708120 |
| Codex | before | 70.790 | 6 | 123,711 | 0.27480350 | 0.23272670 |
| Codex | after | 67.065 | 7 | 177,966 | 0.35049150 | 0.24038020 |
| Pi | before | — | — | missing | missing | 0.06844350 † |
| Pi | after | — | — | missing | missing | 0.06729540 † |

The canonical report has **$2.72674505** known combined cost across **4/6**
attempts: $1.60294575 subject plus $1.12379930 grader. The two retained Pi
`usage.jsonl` sidecars were priced offline with the existing obol integration
(†), recovering **$0.13573890** of additional grader cost. This gives
**$2.86248395 known pilot cost**, with grader coverage **6/6** and subject
coverage **4/6**. The canonical report was not rewritten. Missing Pi subject
usage is not replaced with zero, even though the captures show startup failed
before input.

Pricing provenance is obol 0.9.0, rate date `2026-08-05`; Codex subject estimates
carry obol's `AssumedStandardTier` approximation. There are no unpriced models
in the measured usage. No paid fixture generation or separate assessment batch
was run. Operator preparation, code review, and this assessment conversation
are not metered by the campaign and are outside the known subtotal; a complete
all-in bill is unavailable. The $15 observed-spend cancellation tripwire was
not reached.

### Evidence pointers

Campaign/control evidence is retained under
`/srv/quorum/pilots/pr2236-discovery-20260909/evals/campaigns/`
`b3f8c734-1207-443e-8982-1174fea79af8-pr2236_session_discovery`.
Published attempt evidence is under
`/srv/quorum/pilots/pr2236-discovery-20260909/results/<run-id>/`:

| Harness | Arm | Run id |
|---|---|---|
| Claude | before | `diagnosing-session-discovery-claude-opus_bedrock-linux-20260909T233801Z-881c` |
| Claude | after | `diagnosing-session-discovery-claude-opus_bedrock-linux-20260909T233801Z-392e` |
| Codex | before | `diagnosing-session-discovery-codex-openai_responses_56sol-linux-20260909T234139Z-10d1` |
| Codex | after | `diagnosing-session-discovery-codex-openai_responses_56sol-linux-20260909T234139Z-5f5b` |
| Pi | before | `diagnosing-session-discovery-pi-pi_gpt56_sol-linux-20260909T234418Z-c614` |
| Pi | after | `diagnosing-session-discovery-pi-pi_gpt56_sol-linux-20260909T234418Z-baee` |

Private local evidence root:
`/Users/drewritter/.local/share/superpowers-evals/pr2236-session-discovery-20260909`.
It contains the frozen campaign report/anchor, registration and launch receipts,
152 hash-verified collected files, `runtime-image-audit.json`, `readout.json`,
and six `assessments/p01..p06/assessment.json` records. The four exposed attempts
also retain verbatim final answers, structured reviewer extractions, native
histories, tool-audit inputs, and mechanical CLI results. The Pi records retain
the startup captures and recovered grader estimates; absent answers/history are
explicit, with no fabricated mechanical result. These private artifacts remain
outside source control and worker mounts.

### Decision

The shared procedure is a viable candidate on the observed Claude and Codex
ordinary tasks. The preregistered all-three condition remains unmet because Pi
was unexposed and Claude did not satisfy the absolute-path reporting check. Keep
the mechanical and semantic disagreement visible; do not turn this into a
six-pass claim or a release-level result.

The next targeted check is **only the Pi before/after pair after correcting and
offline-verifying the long-path startup problem**. No such follow-up was launched.
This pilot ends with this readout; the treatment and eval work remain in their
isolated worktrees.

The user subsequently authorized the [Pi startup fix and two-attempt
follow-up](2026-09-09-pr2236-pi-followup.md). Its evidence is recorded separately;
the original results above are retained.

## Preregistered allowance

The preregistered working cost estimate was **$5–10**, with a **$25 all-in
allowance** for the six attempts and a manual cancellation tripwire at **$15 tracked spend** to
leave room for in-flight usage. This is an operational allowance, not an
automatically enforced billing cap. No extra attempts or fixture-generation
calls are admitted. Unknown usage remains explicit in the readout.

The estimate uses historical comparison evidence: the
[September 4 multiharness campaign](2026-09-04-multiharness-signature.md)
recorded $0.81 per run on its cheaper scenario mix, and the
[September 7 short probes](2026-09-06-pr2258-five-model-campaign.md)
recorded roughly $0.49–1.00 combined across two attempts. These are historical
cost estimates, not measurements of this new discovery task. The additional
allowance covers unfamiliar discovery behavior and grader overhead.
