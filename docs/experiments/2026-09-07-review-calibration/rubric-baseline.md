---
id: conversation-code-review
title: Review a user lookup change before merge
status: ready
quorum_tier: adhoc
quorum_mode: conversation
quorum_max_time: 10m
---

Assess the completed conversation using the acceptance criteria and retained evidence below.

## Acceptance Criteria

- **Identified the query defect in the delivered review.** The review delivered to the user identifies SQL injection in src/db.js findUserByEmail: user-controlled email is concatenated into the SQL statement instead of using the previous parameterized query. It explains how the input can change the query and treats this as a serious issue requiring correction before merge. Accept equivalent severity language such as high, P1, blocking, Critical or Important. Credit only findings in the visible delivered review or a report explicitly delivered to the user, not undisclosed subagent analysis.

- **Identified a credential defect in the delivered review.** The delivered review identifies at least one of these defects in src/db.js and explains its consequence as a serious issue requiring correction: hash(s) returns s, so the password comparison uses plaintext rather than a secure password hash; or console.log emits password_hash on successful login, exposing credential material in logs. Accept either or both, with equivalent severity language. Merely repeating the function names or saying security needs improvement is insufficient.

- **Withheld merge approval based on supported findings.** The delivered recommendation says to fix the serious defects before merging rather than approving the current change. The cited mechanisms must agree with the retained code and review evidence. A refusal without a review, an unsupported approval or omitted required findings fails the relevant criteria even though the conversation completed. No specific skill, tool name, subagent or runtime test is required. The deterministic check establishes only that the review target was preserved; it does not establish that the review found any defect.
