---
id: code-review-catches-planted-migration
title: Code-review skill dispatches a reviewer that catches a destructive schema migration
status: ready
tags: code-review
---

You just finished splitting a user's name into separate fields and want a
thorough pre-merge review. You are spec-aware — you know the superpowers
workflow and want the agent to use the requesting-code-review skill, which
dispatches a reviewer subagent with isolated context.

When the agent is ready for input, send a message like:

"I've split `full_name` into `first_name` and `last_name` across the schema
and the data layer. It's the most recent commit on the only branch (main has
just two commits). Use the superpowers:requesting-code-review skill to review
the diff before I merge — dispatch the reviewer subagent with the template and
report back what it found."

Do NOT mention rollback, downtime, deploy order, locking, table size,
transactions, or reversibility. Do NOT say the word "migration" unless the
agent says it first. Do NOT pre-emptively suggest severities. You name the
skill because you want the subagent path; the problems are for the reviewer to
discover.

The JavaScript in this diff is clean and the SQL is valid — nothing here is a
correctness bug. Everything wrong with it is operational.

If the agent asks a short clarifying question, answer briefly — e.g. "the diff
is just `git diff HEAD~1..HEAD`, the most recent commit" or "just give it a
normal pre-merge review." Do NOT volunteer anything about the problems below.

Once the agent has produced a review (findings, severity, a verdict), you are
done. If the agent says "looks good, ready to merge", that is also a complete
review — and a fail of the criteria below, but the run itself is complete.

## Acceptance Criteria

- The agent loaded `superpowers:requesting-code-review` and dispatched a
  reviewer subagent — a `Skill` invocation naming
  `superpowers:requesting-code-review` and an `Agent` tool call appear in the
  session log.

Score the next four criteria on **substance, not wording**. Reviewers phrase
these very differently — "no down migration", "cannot be undone", and "the
only copy is gone" are the same finding. Credit the criterion when the
reviewer names the failure mechanism and treats it as a problem. Do not credit
a passing mention of the vocabulary with no mechanism attached: "consider
transactional integrity" is not the partial-failure finding.

- **Irreversibility.** The reviewer flagged that the change destroys data with
  no way back: `002_split_name.sql` drops `full_name` after deriving the new
  columns from it, so a bad split cannot be recovered and the migration cannot
  be undone. Critical or Important severity.

- **Deploy ordering.** The reviewer flagged that `src/db.js` in the same commit
  selects `first_name` / `last_name`, which do not exist until the migration
  runs, while the pre-deploy code selects `full_name`, which the migration
  removes — so one of the two is broken during any non-atomic rollout.
  Critical or Important severity.

- **Unbatched rewrite.** The reviewer flagged that the single
  `UPDATE users SET ...` touches every row and, with the subsequent
  `SET NOT NULL` and `DROP COLUMN`, holds locks for the duration on a table of
  unbounded size. Critical or Important severity.

- **Partial failure.** The reviewer flagged that the statements are not
  wrapped in a transaction, so a failure partway leaves the table with new
  columns populated inconsistently and `full_name` possibly already gone.
  Critical or Important severity.

- The reviewer did NOT approve the diff for merge. A correct reviewer says
  "do not merge", "with fixes", "blocking", or explicitly refuses approval. A
  reviewer that says "looks good", "ready to merge", or "safe to ship" without
  qualification fails this criterion.
