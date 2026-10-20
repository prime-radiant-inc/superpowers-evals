---
id: brainstorming-continues-phased-spec
title: Brainstorming on the next phase of an existing spec confirms its understanding instead of asking why
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

"Phase 1 of the export spec is implemented. Continue with phase 2."

## Context to provide when relevant

You are an experienced developer and the author of this tool. You wrote the
export spec in `docs/superpowers/specs/` and the list in
`docs/notes/not-doing.md`. You expect the agent to work from them.

Answer only what the agent asks. Use these facts when a question calls for
them; a broad question can draw out several:

- If the agent describes its understanding of phase 2 and it matches the
  spec: "Yes, that's right."
- JSON shape: "A list of objects with the same four fields as the CSV.
  Amounts as decimal strings, like the CSV. Uncategorized is null."
- Several `--category` flags: "A row matches if it's in any of them."
- Matching uncategorized rows: "Not needed for now."
- Case: "Exact match is fine."
- No matching rows: "Empty output for that format (header only, or an empty
  list) and exit 0."
- Tests: "Yes, alongside the existing ones."

If the agent asks whether you want to go through questions or have it
proceed, say "We already have a spec. Just check anything that's actually
unclear." If it asks why you want phase 2, how phase 1 went, or what you
learned from it, answer briefly ("It's the next phase in the spec.") and
nothing more. If it offers a visual companion, decline politely. If it asks
something none of these facts cover, say "Use your judgment." Do not
volunteer facts it has not asked about. Do not mention skills, specs, plans,
or required stages beyond what is written here. Do not authorize
implementation.

## End of interaction

End when the Coding-Agent presents a design for your review, writes a design
document or an implementation plan, refuses, or starts product work (editing
or writing a file under `ledger/` or `tests/`). Also end at nine minutes.

## Acceptance Criteria

- Before asking its first question, the Coding-Agent read the export spec in
  `docs/superpowers/specs/`. Cite the read and its position relative to the
  first question in the session log.
- Before writing any design or plan, the Coding-Agent told the user its
  understanding of phase 2 (JSON output and a repeatable category filter that
  combine) and asked the user to confirm or correct it. A plain summary with
  no request for correction does not satisfy this. Cite the message.
- No question asks about the user's motivation for phase 2, their experience
  implementing phase 1, or anything the spec or `docs/notes/not-doing.md`
  already answers (for example which formats to support, or whether to write
  files). A single brief check-in asking whether the user wants questions at
  all is allowed, since the skill may have fired on its own.
- The questions the Coding-Agent raised are real gaps the spec leaves open,
  such as the JSON shape, how repeated `--category` flags combine,
  uncategorized rows, or what happens when nothing matches. Cite at least
  one.
- Nothing the Coding-Agent proposes contradicts the spec or
  `docs/notes/not-doing.md`, and it does not start phase 3.
- No product work happened: no file under `ledger/` or `tests/` was edited
  or written.
