# Conversation-mode code review pilot

Status: completed the two attempts approved by Drew with "sgtm". Both published
passes with complete evidence and costs. Independent inspection found a material
assessment limitation: Claude's review included unsupported claims that its
assessor did not flag. The original report is retained unchanged.

## Question and scope

Can the working conversation-to-assessment path grade a delivered code review
against known defects, rather than grading another executable pricing fix?

Use conversation-code-review, a variant of code-review-catches-planted-bugs.
Both invoke the same create_code_review_planted_bugs helper without changes.
The two-commit fixture contains SQL concatenation of email, an identity password
hash and credential logging. It has no database driver or test runner; this is
a static review task. The user asks for findings and a merge recommendation,
explicitly asks for no code changes, and does not name defects or skills.

The private rubric requires a delivered SQL-injection finding, at least one
credential finding, and withholding merge approval until the serious issues
are fixed. Equivalent severity language is accepted. Findings hidden in a
subagent conversation do not count unless delivered to the user. Refusal,
wrong approval and missing findings remain completed behavioral results.

The scenario-owned oracle hashes the reviewed src/db.js, both before launch
and after capture. It checks source preservation only and never executes the
subject's JavaScript. A passing hash check is not evidence of a correct review.
The unchanged conversation runtime requires oracle.cjs; this scenario supplies
a meaningful task-specific check through that existing contract. No runtime
source, fixture helper, scheduler, credential or assessment interface changes.

Evidence includes final source bytes, the visible conversation and native plus
normalized transcripts. The source contains all three target defects. Snapshot
capture excludes .git; do not claim a separately frozen historical diff unless
the subject's captured transcript actually contains it.

## Fixed execution inputs

Exactly two fresh attempts: one conversation_claude arm and one
conversation_codex arm, through suites/conversation_code_review.yaml at global
cap 2. Reserve 0, max_attempts 1, no retries or replacement runs. Preserve the
ten-minute conversation, two-minute assessor and fifteen-minute outer bounds.
The operator stop allocation is $10 for this two-run follow-up, not an invoice
ceiling. Stop remaining work on instrument failure, unusable role behavior,
missing endpoint/evidence/started-role usage, wrong routing or allocation
exhaustion. A completed bad review remains signal and is not retried.

Reuse the existing isolated installed appliance helper at
/srv/quorum/pilots/conversation-assessment/bin/evals-appliance over Tailscale
SSH, with its canonical host-wide live-spend lock and blessed credential bundle.
The appliance owns execution and is polled until completion. Preserve canonical
checkouts, the existing image and base container.

| Role | Credential | Model / effort |
|---|---|---|
| Claude lead | opus5_bedrock | anthropic.claude-opus-5 / high |
| Codex lead | openai_responses_56sol | gpt-5.6-sol / high |
| User and assessor | sonnet5_bedrock | anthropic.claude-sonnet-5 |

Both arms keep Superpowers b36e0829c6d0140e93cfef2ca599b1b07d4a7797.
Gauntlet stays at 74d2037aed14f413db482b7635783e4e0498c316. Quorum runtime
remains d52b36be, plus subsequent scenario/declaration/documentation commits.
Registration records the exact committed source snapshot. The pricing snapshot
is docs/experiments/2026-09-06-pr2258-pricing/current.json, SHA-256
6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b.
Record subject-selected secondary models separately, as in the pricing pilot.

## Verification and results

The preservation test first failed because the new checker was absent, then
passed against the real existing setup fixture. It covers unchanged, changed
and missing target bytes and confirms altered JavaScript is not executed.
Changed-test Biome, TypeScript and oracle syntax checks passed. All scenarios,
credentials, arms and suites validate. The new expected-check manifest is
generated. The actual new setup and check phases passed (five prechecks, one
post-check), and their emitted records match that manifest. Independent review found no actionable blockers in the scenario,
suite, oracle and test; the reviewer did not rerun root's checks.

Appliance preflight: the installed helper's doctor passed, no shared spend lock
or attempt containers were present, and the three isolated source checkouts
were clean at their previous pilot pins. Transferred the committed source via
a Git bundle and fast-forwarded only the isolated Evals checkout; appliance
source validation passed.

Campaign 6b066da6-66c6-4672-9887-c3db958b64f7 registered and launched through
the installed helper. Quorum source is
5ec5784fb06655c07b8cd3f9d7c4390a987e9155; Gauntlet and Superpowers pins match
those above. Registration confirms exactly two planned slots, no reserves,
cap 2 and the expected model routes. Attempts are
c1:conversation-code-review:conversation_claude:r1:a1 and
c2:conversation-code-review:conversation_codex:r1:a1.

### Live result

Both attempts completed delivery, passed all three assessment criteria and the
source-preservation checks, and published with publication_valid true,
analysis_usable true and no missingness. Both role processes exited zero and
all started-role usage is priced. There were no retries, replacements, instrument
errors or runtime changes during the pilot.

| Harness | Published run suffix (20260908) | Worker seconds | Subject USD | User USD | Assessor USD | Campaign-accounted total USD |
|---|---|---:|---:|---:|---:|---:|
| Claude | T032929Z-1138 | 305.919 | 0.99881575 | 1.1804866 | 0.0643252 | 2.24362775 |
| Codex | T032930Z-eaf9 | 151.055 | 0.2634324 | 0.2078388 | 0.0332888 | 0.50456040 |
| Total | — | 456.974 | 1.26224815 | 1.3883254 | 0.0976140 | **2.74818815** |

Role totals have their own rounding; the last column uses the unchanged
standard campaign accounting. These are frozen-pricing estimates, not invoices.
The campaign ran 03:29:28.085–03:34:47.046 UTC on September 8, **318.961
seconds**. Both conversation phases overlapped for **132.551 seconds**.
Conversation/assessment durations were 285.292/19.825 seconds for Claude and
132.551/17.779 seconds for Codex. Each assessor began after its own conversation
ended. No speed or model ranking is justified from these two observations.

Codex used gpt-5.6-sol high without a secondary-model session. Claude's lead and
captured review subagent both used claude-opus-5. Both native captures contain
Superpowers context. The captured output of both runs contains only package.json
and src/db.js; the review-target SHA-256 matches the unchanged fixture:
89d327d35e468272115f40b2f0b995a5b279ce61d5436701d7ca768913dcc6f0.

### Independent inspection and negative finding

Root and the independent reviewer inspected the delivered reviews, actor
exchange, underlying source and assessments. Both actors supplied the exact
review request without defect coaching or follow-up repair requests.

Codex's final visible capture 033 and trajectory step 20 deliver the required
SQL-injection and credential findings with concrete file locations and a
"Not ready to merge" recommendation. Trajectory steps 11 and 19 retain the
actual before/after diff, supporting the parameterization-regression claim.
Its assessment cites the delivered review and code accurately; it does not
substitute the preservation check for review quality. This pass is supportable.

Claude's captures 092–094 and trajectory step 17 also deliver the required
planted findings and withhold merge approval. However, its ten-finding review
contains material overclaims:

- It assumes db.query returns an array, acknowledges the driver is absent,
  then says the resulting authentication bypass "stands regardless." A driver
  returning a row or null defeats that inference.
- It assumes SSO/passwordless null-password rows and downstream callers that
  are not present in the fixture.
- Plaintext comparison does not establish how passwords are stored, and a
  missing driver does not establish that the commit was never executed.
- SQL injection changes the constructed query; saying login necessarily
  returns every row ignores its subsequent password check.

The assessor correctly cites the required detections, but fails to flag those
unsupported claims and broadly says the findings match the code. That is too
permissive under the rubric's supported-findings language. The publication and
capture are operationally valid; the published PASS establishes required-defect
detection, not ten verified defects or an entirely accurate review. This is an
assessment-quality finding, not missing evidence or a reason to rerun the
harness. Neither the grading record nor the rubric was silently changed after
the result was seen.

This follow-up therefore establishes a second live deliverable type through the
same core engine and exposes a useful next target: calibrate assessment on
retained reviews containing both true findings and unsupported claims. The
positive detections must not excuse invented facts. That calibration is a
proposed next step, not another authorized paid run in this pilot. Broader
harness coverage, a live refusal/bad-delivery test and sustained throughput
remain unproved.

### Evidence and cleanup

Standard report.json/report.md and campaign records are at:
/srv/quorum/pilots/conversation-assessment/superpowers-evals/campaigns/6b066da6-66c6-4672-9887-c3db958b64f7-conversation_code_review/.
Published run directories under the appliance's results/ are:

- conversation-code-review-claude-opus5_bedrock-linux-20260908T032929Z-1138
- conversation-code-review-codex-openai_responses_56sol-linux-20260908T032930Z-eaf9

Operation receipts are in the same pilot root under receipts/review-*. Selected
standard reports and per-run verdict/conversation/role JSON are copied to the
ignored local results/conversation-code-review-pilot/ directory. Generated
reports are unmodified; native transcripts remain on the trusted appliance.
No credential HOME or raw transcript was added to Git.

The final standard report records completed, complete and termination_verified.
Only the preexisting base container remained; no attempt containers or shared
spend lock remained. Canonical Q/G/S checkouts were clean and retained their
original revisions (6c215603, 588a81e8, fd02874a). The isolated Evals source was
clean at 5ec5784f. Local scenario and experiment commits remain unpushed and
unmerged. No work beyond the two declared attempts was launched.
