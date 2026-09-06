# Codex reasoning metadata fixture

This reduced shape fixture covers metadata observed in all four Codex attempts
of diagnostic campaign `d3871573-98b6-41f1-ae27-737f84c7658c`, using Codex
`0.146.0` at Evals `c3e1c440b1042de9becd6762dd3911824822447a`.
It is not an untouched transcript or complete native grammar qualification.

The original Astra base transcript SHA-256 is
`0f02b6fbaaa779e5bc1b7d249aa0ad6d15df899f7989fcc0c5ec73e5b3d02a26`.
Its reasoning response items occur at lines 9, 13, 25 and 35; reasoning telemetry
at lines 22-24 and 34; message telemetry uses `commentary` at lines 14 and 26
and `final_answer` at line 39. The original remains in that attempt's private
`home/.codex/sessions/2026/09/06/` directory, file
`rollout-2026-09-06T06-24-37-01a07563-ea04-7c63-a141-a55238028e99.jsonl`.

Reasoning and telemetry key sets, JSON value types, summary discriminant, empty
summary variant, and phase values are retained. IDs, paths, encrypted content,
summary text and message text are replaced. The approval-like text is an
intentional synthetic adversarial value: reasoning must not create approvals or
physical actions. The minimal session, user message, call/result and assistant
messages are synthetic scaffolding that tests the same public indexing contract.
No opaque reasoning content, credential, provider response or original raw
session content is included. No historical attempt is replayed or rescored.
