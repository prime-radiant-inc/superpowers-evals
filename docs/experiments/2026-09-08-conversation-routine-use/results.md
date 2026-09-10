# Routine-use comparison partial release — 2026-09-09

This release stopped during live assessment qualification. The source and
private corpus passed their offline gates, but the live assessor produced one
unsupported material judgment and then one interrupted session with no accepted
result. The fixed stop rules barred another admission. No driver qualification,
stock/treatment campaign, comparison report, source promotion, CI delivery or
canonical installation followed.

This is a useful negative result about the release instrument. It is not a
Superpowers-versus-stock result and supports no treatment-effect conclusion.

## Questions and frozen configuration

The product question was whether a maintainer could use the ordinary workflow
to compare pinned Superpowers with stock on the same task, harness and model,
then read supported quality, time and cost results from the normal report. The
behavioral hypothesis was deliberately nondirectional: a supported win, loss or
no-benefit result could complete the experiment. The assessment hypothesis was
that the atomic submission contract would reproduce every independently
supported atom and its fold to the unchanged original criteria across the fixed
retained corpus. Invalid driver behavior or unsupported grading would instead
fail the instrument gate and could not establish an effect.

| Item | Frozen identity or limit |
| --- | --- |
| Candidate quorum | `ae3f6633261667d1684fd80d87441db99381c12f` |
| Candidate Gauntlet | `690432bd295acd199595f875abf9eda25ee06ce0` |
| Stock / treatment | `superpowers: none` / `b36e0829c6d0140e93cfef2ca599b1b07d4a7797` |
| Worker image | `sha256:01fb1cd08f1e31c82fccedbaadead09e6ff97bca1f5d66f2f0904728ad536e8c` |
| Candidate config SHA-256 | `35c6619215bd09f2e33355c69246bc9c96ced636d75a738107085f1ee5392082` |
| Grader | `anthropic.claude-sonnet-5` through `sonnet5_bedrock` |
| Coding-Agent routes | Claude `anthropic.claude-opus-5` high; Codex `gpt-5.6-sol` high; Pi `gpt-5.6-sol` at its existing default effort |
| Frozen pricing SHA-256 | `6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b` |
| First round | 18 assessments, then 12 drivers, then 36 fresh attempts only if both roles qualified |
| Absolute maxima | 36 assessments, 24 drivers, 72 fresh attempts; one shared integrated repair |
| Attempt limits | 120-second qualification role plus 2-second cleanup; fresh conversation/assessment/outer bounds 600/120/900 seconds |
| Global limits | cap 4; two repetitions; one attempt per sample; six-hour original window; $150 observed stop |

The $150 threshold was an observed stopping threshold, not a hard provider
billing cap. The fixed suite declared 16 Claude, 16 Codex and 4 Pi attempts
across three matched stock/treatment comparisons. Only the assessment gate
began, so none of those 36 fresh attempts exists.

## Offline source and runtime gates

Independent review authenticated the nine-case private corpus, all 90 atomic
expectations, their mappings to the unchanged original criteria, 896 indexed
evidence files, and the driver-control declarations. The first whole-source
review retained one real negative: quorum's aggregate check had 3,868 passes,
27 expected opt-in skips and one failure because the new
`conversation-config-repair` restriction was missing from the exact intentional
pin set. Commit `ae3f6633` added that one scenario name without broadening its
Claude/Codex eligibility. The focused check then had 3 passes and no failures;
the required aggregate had 3,869 passes, 27 expected opt-in skips and no
failures, plus 144 passing dashboard tests. Scoped independent rereview found no
remaining source finding and approved the candidate only in composition with
the original full review.

Other retained source checks were green: the actual paired quorum/Gauntlet
fixtures had 60 passes and one private-corpus opt-in skip; the retained operator
suite had 98 passes; the separately enabled private-corpus test had 16 passes;
`quorum check` passed; and Gauntlet's full check had 1,395 passes, two
provider-gated skips and no failures. The source/corpus review receipts are
SHA-256 `bd829c5ab13e19d85fe6e1b8655da0d99b4624f69e94b1974b7b436c98624d15`
and, after the pin correction,
`9d4c96d5ce6a407697ae05f3bd2c39b6615760002fc43d230b8007ba8b637bfd`.
Passing source checks qualified the offline candidate; they did not qualify its
live assessor or driver.

The appliance host lacked the driver's `tmux` prerequisite. The staged preflight
installed only `tmux` 3.6a, preserved the image and configuration, and verified
its private socket cleanup. An actual staged, credential-free loopback driver
then completed four returned turns with matching usage counters, the expected
delivery endpoint and cleanup. Its estimated `$0.0003024` was synthetic fixture
usage and is excluded from paid spend. A separate detached-entrypoint preflight
verified the manifest digest, argv, process identity, private log and lease
release before any envelope or provider admission. Candidate doctor and private
corpus loading passed.

## Paid assessment results

The original paid envelope began at `2026-09-09T10:11:42.450Z`. Its fixed
six-hour cutoff was `2026-09-09T16:11:42.450Z`, with cancellation due one minute
earlier. The assessment operation used manifest SHA-256
`63dac509cc81e3cbf8965aa36ea9b79eecd5c792d38db2135d58e6d50475f6b4`.
It stopped at `10:16:04.221Z`, 261.771 seconds after first paid admission and
well before the time and observed-dollar limits.

| Ordinal / case | Duration | Returned usage | Known USD | Independent semantic result |
| --- | ---: | ---: | ---: | --- |
| 01 / `claude-design`, repetition 1 | 79.503s | 6 of 6 responses | 0.1965774 | Unqualified. The assessor falsely passed atom 6 by treating generic all-task completion notices as the required watched-task behavior, changing original fold 2 from fail to pass. |
| 02 / `claude-design`, repetition 2 | 62.140s | 6 of 6 responses | 0.1331051 | Qualified. All 10 atoms, all 3 original folds and their material rationales matched independent review. |
| 03 / `known-claude-design`, repetition 1 | 120.004s | 8 of 9 requests returned | 0.2042426 | Operationally unqualified. Three submissions omitted `criteria` and were rejected; the deadline ended the role by SIGTERM with no accepted `result.json`. All 10 expected atoms and all 3 original folds were pass, but no actual judgments exist. |

Ordinal 03 finished 4ms after the nominal role deadline and within the separate
two-second cleanup allowance; there was no cleanup-budget overrun. The
unfinished ninth request still makes strict returned-turn coverage incomplete.

## Immutable attempt pointers

The private appliance root is `/srv/quorum/pilots/cru-20260909`. Paths below
are evidence locators only; no transcript content or credential material is
published here.

| Ordinal | Role directory below `r/assessment-1` | Authenticated evidence |
| --- | --- | --- |
| 01 | `01/role/conversation-design_20260909T101142Z_w10q` | `run.jsonl` SHA-256 `c147b218ab927f437dc7adf62c02dba1bb3a9719aa5fb077ceb6db533ce0e72d`; `result.json` SHA-256 `0850418d58f346cc4d10535b4c0763d1cbe768b8ff30675f0a46d2d967166be5`; `01/settled.json` SHA-256 `59247afffde491e45d7d3c9821ab08d52657e560e046d7fde1a35bad5810d389` |
| 02 | `02/role/conversation-design_20260909T101302Z_84y2` | `run.jsonl` SHA-256 `30513acbff6e782fcf6d85455e23237a140ef1efccc81071115e29a594987f16`; `result.json` SHA-256 `ca5ea3bd09d469eeafd316a5513c8b82b9286f7775ff6404495c81ae51f98007`; `02/settled.json` SHA-256 `c564188c958cf6cdfe6827b0617d31197dc57f5d93ae07cec7891824b92aa217` |
| 03 | `03/role/conversation-design_20260909T101404Z_01b2` | `run.jsonl` SHA-256 `f16ba982134e5c250eb6bc0701453f73e006ba09698f67b4042c3b83e039ab95`; no accepted result; `03/settled.json` SHA-256 `0cec2de50689624dbe07192b03c4a3706d1b9229ab1c8080b26f844c518574b5` |

The independent audit rehashed 330 indexed source files and 20 immutable
snapshot files. It evaluated all 20 material atoms and six original folds from
the two complete sessions, recorded the ten absent atom rows from ordinal 03,
and found no expectation defect. Original rubrics, evidence and gold were not
changed. Its receipt is retained at
`final-audit/audit-design-receipt.json` under the private root.

## Stop, accounting and cleanup

All 20 returned responses have matching raw usage rows and exact normalized
input, output, cache-create and cache-read counters. Frozen pricing gives known
returned usage of **$0.5339251**. Ordinal 03 had one provider request in flight
when it was terminated. Its eventual invoice usage is unknown, so this report
does not claim complete accounting, a final bill, or enforcement of a hard
billing cap.

The missing final evidence and incomplete accounting triggered the fixed hard
stop after 3 of 18 assessments. The unused integrated repair did not authorize
another admission after that stop. Ordinals 04–18, all 12 drivers and all fresh
attempts are unrun, rather than passes or failures.

Cleanup verification found the detached operator absent, no owned role process,
and no private operation, appliance run/sync or shared spend lock. The private
staging material was archived and its live staging directory removed after
process checks. The canonical image remained unchanged. There was no six-hour,
$150, or cleanup overrun; the accounting limitation above remains open.

## Cumulative release status

| Area | Status | Evidence boundary |
| --- | --- | --- |
| Authoring | Source-complete, offline-qualified candidate | Natural briefs, the new repair scenario, atomic rubrics, matched arms and fixed suite passed source/corpus review. They remain on a private candidate branch. |
| Driver fidelity | Offline preflight only | The staged credential-free driver exercised four turns, delivery and cleanup. The fixed 12-session live driver gate was never admitted. |
| Assessment | Failed live qualification | One of three consumed sessions qualified; one had a material false pass and one ended without a valid result. Fifteen first-round sessions were not run. |
| Comparison and report | Implemented and source-tested, no experiment result | The ordinary 36-attempt suite and report rendering passed offline checks. No campaign was registered, so there is no UUID, driver audit, stock/treatment cohort, ordinary campaign report or supported effect estimate. |
| Installed acceptance | Not eligible | No push, merge, CI run for a promoted pair, or canonical campaign-source update occurred. Private staging is not canonical installation. |

Final non-promotion verification found the canonical checkouts clean and
unchanged: quorum `b0353a10d8c8eddb69b04eb899d73f0e981fdad8`, Gauntlet
`256feaea65ea0016dec4133f2cd031bd72be8754`, and Superpowers
`b36e0829c6d0140e93cfef2ca599b1b07d4a7797`. The canonical configuration
remained SHA-256
`2381a33efb35957dea318aa00cd0e97b4933b36c9618795d8d7d2e716bf38420`,
the image remained `sha256:01fb1cd08f1e31c82fccedbaadead09e6ff97bca1f5d66f2f0904728ad536e8c`,
doctor was healthy, and mutation locks were released. The private candidate
checkouts at the Q/G identities above were also clean.

## Limits and deferred evidence

Three assessment sessions, including only two complete results from one design
case, cannot estimate assessor accuracy or repeatability. The single supported
match does not offset the unsupported pass, and the timeout does not supply a
semantic verdict. Offline driver behavior does not qualify the live driver.
Because no matched subject cell ran, this experiment says nothing about
Superpowers' quality, elapsed-time or cost effect on Claude, Codex or Pi.

The unrun assessment and driver gates, any integrated repair, the fresh
stock/treatment matrix, independent two-stage cohort audit, normal report,
delivery CI and canonical installation remain unqualified deferred evidence.
They require a separately authorized execution with a newly reviewed admission
boundary; this partial record does not promise automatic resumption or further
spend.
