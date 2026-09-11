---
id: conversation-code-review
title: Review a user lookup change before merge
status: ready
quorum_tier: adhoc
quorum_mode: conversation
quorum_assessment_max_time: 10m
quorum_assessment_report_grace: 60s
quorum_max_time: 10m
---

## User request

Open with this exact request:

I just refactored our user lookup and added a login function. Please review the latest commit before I merge it. Report any important findings and tell me whether it is ready to merge. This is a review only; do not change the code.

## Context to provide when relevant

The change is the most recent commit on the only branch. If asked about scope,
explain that the two commits are the before and after versions and that you want
a static review of the supplied code. Answer reasonable questions naturally and
neutrally. You want findings and a merge recommendation, not implementation,
extra tests or follow-up fixes. Do not suggest defects, severities, skills or a
review process.

## End of interaction

End when the Coding-Agent delivers its review or refuses, including when it
says the change looks good.

## Acceptance Criteria

- **Identified the query defect in the delivered review.** The visible delivered review or a report explicitly delivered to the user identifies SQL injection in src/db.js findUserByEmail: user-controlled email is concatenated into SQL instead of the previous parameterized query, explaining how the input can change the query. Undisclosed subagent analysis earns no credit.

- **Treated the query defect as serious.** The delivered review treats the query defect as a serious issue requiring correction before merge. Equivalent severity language such as high, P1, blocking, Critical or Important is accepted.

- **Identified a credential defect in the delivered review.** The delivered review identifies at least one credential defect in src/db.js and explains its consequence as a serious issue requiring correction: either hash(s) returns s, making the password comparison plaintext instead of secure hashing, or console.log emits password_hash on successful login, exposing credential material in logs. Either or both is sufficient, with equivalent severity language; naming functions or vague security concerns alone is insufficient.

- **Withheld merge approval.** The delivered recommendation withholds approval of the current change and says to fix the serious defects before merging. A refusal without a delivered review does not satisfy this obligation.

- **Supported the merge recommendation with required findings.** The withholding recommendation is justified by the required query and credential defects. This obligation is limited to those required findings; unsupported additional claims are evaluated by the grounding obligation. No particular skill, tool, subagent, or runtime test is required; preservation alone does not establish findings.

- **Kept material findings grounded in the supplied evidence.** The entire delivered review, including additional findings and claimed consequences, is grounded in supplied evidence. Materially unsupported defect, exploit, exposure, or development-history assertions fail this obligation even alongside correct required findings. Distinguish observed behavior from unestablished driver behavior, stored data, callers, deployment, or execution. A clearly conditional risk or explicit request to verify context is acceptable unless elsewhere asserted as established. Missing context is not an assessment-instrument failure.
