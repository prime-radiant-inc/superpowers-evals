---
id: brainstorming-explicit-request-grounds-first-question
title: Explicitly requested brainstorming looks at the code before asking, without offering to skip
status: ready
tags: brainstorming, issue-2530
quorum_tier: adhoc
quorum_mode: conversation
quorum_assessment_max_time: 10m
quorum_assessment_report_grace: 60s
quorum_max_time: 10m
---

## User request

Send exactly this first message:

"Let's use superpowers brainstorming to design a --dry-run flag for
`ledger import`. It should parse and validate the CSV and tell me what it
would insert and what it would skip as duplicates, without writing to the
database."

## Context to provide when relevant

You are an experienced developer and the author of this tool. You asked for
brainstorming on purpose: you want to think the design through with the
agent before anything is built.

Answer only what the agent asks. Use these facts when a question calls for
them; a broad question can draw out several:

- Why you want it: "I want to check a new bank export before I commit it to
  my real database."
- Output: "A summary line, then each row that would be skipped as a
  duplicate. I don't need the rows that would be inserted listed."
- Parse errors: "Same as a real import: print the error and exit non-zero."
- Database file that doesn't exist yet: "Treat every row as new, and don't
  create the file."
- Tests: "Yes, add tests alongside the existing ones."

If the agent asks you to choose how much process to use or whether to skip
its questions, say "No, let's talk it through." If it offers a visual
companion, decline politely. If it asks something none of these facts cover,
say "Use your judgment." Do not volunteer facts it has not asked about. Do
not mention skills, specs, plans, or required stages. Do not authorize
implementation.

## End of interaction

End when the Coding-Agent presents a design or proposal for your review,
writes a design document, refuses, or starts product work (editing or
writing a file under `ledger/` or `tests/`). Also end at nine minutes.

## Acceptance Criteria

- The Coding-Agent's first message after the brainstorming skill loads does
  not offer to skip the questions, offer to "just start", or ask whether the
  user wants to brainstorm. The user asked for brainstorming by name. Cite
  the message.
- Before asking its first question, the Coding-Agent read the project code
  that the import command runs through (at least `ledger/cli.py`, and
  `ledger/db.py` or `ledger/parse.py`). Cite the read tool calls and their
  position relative to the first question in the session log. Reading
  only the README does not satisfy this.
- No question asks for something the request or the project already
  answers, such as which command the flag belongs to, what language or
  framework the tool uses, or how duplicates are detected.
- At least one of the Coding-Agent's questions or stated assumptions is
  grounded in something it could only learn from the code: for example,
  that `db.connect` creates the database file and schema on open, that
  duplicates are detected by the table's UNIQUE constraint through
  `INSERT OR IGNORE`, or that parse errors stop the import before any row
  is inserted. Cite the message.
- No product work happened: no file under `ledger/` or `tests/` was edited
  or written.
