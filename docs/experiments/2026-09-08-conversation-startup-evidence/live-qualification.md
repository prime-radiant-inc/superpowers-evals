# Conversation engine qualification

Status: Drew approved this allocation; all three cells completed and passed
their engine gates. Both deliverables were promoted. See the
[live results](live-results.md) for standard-report outcomes and installed proof.

Run three small cells through the existing isolated appliance pilot after the
offline candidate passes review. This qualifies Claude startup and Pi evidence,
not grading accuracy or parallel capacity. Preserve completed bad work and its
assessment as signal.

| Order | Suite | Coding-Agent | Engine gate |
| --- | --- | --- | --- |
| 1 | `suites/conversation_claude.yaml` | Claude / `opus5_bedrock` | Ready without startup input; simulated user starts afterward; task interaction and native/visible evidence retained |
| 2 | `suites/conversation_pi_pricing.yaml` | Pi / `pi_gpt56_sol` | Completed pricing interaction with transcript/output evidence, native chronology and source IDs, valid exposure and complete frozen pricing |
| 3 | `suites/conversation_pi_review.yaml` | Pi / `pi_gpt56_sol` | Same evidence contract for code review; launch only if cell 2 passes its engine gate |

Each suite declares one attempt, no reserve and a 900-second attempt deadline.
Use global concurrency one. Existing worker bounds are 600 seconds for the
conversation and 120 seconds for assessment; Claude readiness has its separate
30-second bound within the conversation. Register a fresh identity for each
cell. No automatic retry, replacement or continuation is included.

All arms pin Superpowers `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`. The
simulated-user and assessment roles use `sonnet5_bedrock`. The pricing snapshot is
`docs/experiments/2026-09-06-pr2258-pricing/current.json`, SHA-256
`6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b`.
Use the exact reviewed Quorum/Gauntlet candidate pair recorded in the final
offline results; verify both installed pilot revisions before registration.

Approved new allocation: **$10 total observed spend**, with a **60-minute wall
limit from the first launch**. The allocation is an operator stopping rule,
not a hard provider billing cap: active costs can lag execution. Do not transfer
any prior allocation. Record the absolute wall cutoff before launching cell 1.

Poll the appliance's ordinary status and costs while active. Cancel the active
campaign and withhold remaining cells at the wall cutoff, observed allocation,
loss of trustworthy process ownership, or an explicit unrecoverable engine
failure. Follow the existing cancellation path until owned processes terminate;
cleanup may continue past the cutoff but launches may not. Missing usage while a
role is still running is not by itself an instrumentation failure. At completion,
missing or unpriced role usage fails the engine gate and blocks further spending
until discussed. A subject or assessor's behavioral failure alone does not fail
the engine gate.

Use the installed pilot helper for registration, run, status, costs, report and
cancellation. Do not resume a closed identity. Retain the standard report plus
the private native logs, outputs, exchange and captures; report execution,
assessment and accounting separately.

Claude can be promoted after its own live gate passes. Pi requires both of its
cells. Promotion means direct main integration and canonical appliance update,
followed by separate installed-revision verification. A failed deliverable stays
on its candidate branch with all evidence retained.
