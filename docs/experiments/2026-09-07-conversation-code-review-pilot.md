# Conversation-mode code review pilot

Status: Drew approved the next planted-bug review proof with "sgtm". Scenario
and suite prepared and independently reviewed; live execution pending.

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
were clean at their previous pilot pins. No paid model call has started yet.

Live campaign identity, results, standard-report pointers, costs, independent
evidence inspection and final cleanup will be recorded here after execution.
