# ATIF port — status (handoff)

Branch: `feat/atif-port`. The cutover is **complete on this branch**: capture
now produces the ATIF `trajectory.json` and checks run via the
`check-transcript` CLI. The legacy flat tool-call JSONL layer, the Python
normalizers, and the legacy shell check tools are removed.

## DONE — the ATIF pipeline (`ts/`, bun, zero runtime deps)

- `ts/src/atif/types.ts` — ATIF v1.7 interfaces, pinned `schema_version`.
- `ts/src/atif/validate.ts` — structural validator (schema_version, sequential
  step_id, agent-only-field scoping, same-step `source_call_id`, dup tool ids).
- `ts/src/normalize/*.ts` — one normalizer per agent, all eight TS-backed:
  `claude`, `codex`, `gemini`, `copilot`, `opencode`, `pi`, `kimi`,
  `antigravity`. The `claude` normalizer was validated against a real claude
  2.1.177 transcript. claude and gemini steps carry the source `timestamp`
  where present (the multi-log merge orders by it — see below).
- `ts/src/cli/normalize.ts` — unified dispatcher: `bun run normalize.ts
  <normalizer> <session-log> [--version v]`.
- `ts/src/atif/project.ts` — `flattenToolCalls` → ordered `{tool,args}[]`.
- `ts/src/detect/{skill,implementation}.ts` — skill/implementation predicates.
- `ts/src/check/*` + `ts/src/cli/check-transcript.ts` — the `check-transcript
  <verb>` CLI. Record output is `{check,args,negated,passed,detail}`. The
  empty-capture guard is preserved (negative assertions FAIL on
  empty/missing transcript).

**Verbs (13):** tool-called, tool-not-called, tool-count, tool-before,
skill-called, skill-not-called, skill-before-tool, skill-before-implementation-tool,
implementation-tool-not-called, investigated, worktree-created,
tool-match-before-tool-match, tool-arg-match.

## Cutover (DONE on this branch)

- **Capture emits ATIF.** `quorum/capture.py` diffs the run's new session
  logs, normalizes them via the bun CLI (`quorum/atif.py`), and writes
  `run_dir/trajectory.json`; checks read it via `QUORUM_TRANSCRIPT_PATH`.
  `row_count` is the trajectory's tool_call count; a zero-row/failed/empty
  capture removes any stale `trajectory.json` so loaders fail closed and the
  empty-capture retry (PRI-2081) still fires.
- **Multi-log merge.** A run can produce more than one session log (gemini
  main + subagent chats; any agent's subagent runs each write their own file).
  Capture normalizes EVERY new log and merges their steps into ONE trajectory,
  ordered by step `timestamp` (ISO-8601) with a stable fallback to (file order,
  then in-file order) for steps without a timestamp; `step_id` is renumbered
  sequentially from 1. Observations still reference tool_call_ids in their own
  step, so `validateTrajectory` stays satisfied. (Emitting from only the first
  log silently dropped every tool call in the others — a data-loss regression
  that this merge fixes.)
- **Python normalizers removed.** `quorum/normalizers.py` is gone; the
  log-location / cwd-attribution helpers live in `quorum/log_filters.py`.
- **Flat-JSONL layer removed.** Capture no longer writes
  `coding-agent-tool-calls.jsonl`; `QUORUM_TOOL_CALLS_PATH` is no longer set.
- **Legacy shell check tools deleted**; scenarios use `check-transcript`.
- **Composer trace-check guard** (`TRACE_PRIMITIVES`) lists every verb the
  `check-transcript` CLI emits, so an empty capture forces `indeterminate`
  rather than a false pass/fail for any trace scenario.

## Open decisions (not bugs)

- `tool-arg-match` contract: the TS verb exists; confirm the caller-side arg
  shape is what all ~6 scenarios need.
- `loadCalls()` still can't distinguish a corrupt trajectory from "no
  transcript"; both read as empty. Fine for the negative-assertion contract;
  add a distinct diagnostic if this becomes load-bearing.

## Separate, higher-priority bug (B1, not part of this port)

The claude capture B1 issue is a **launcher** bug, not a transcript-location
bug: claude 2.1.177 writes the legacy `projects/<munged>/<uuid>.jsonl` where
the harness globs, but a quorum-launched claude did not persist the transcript
in the reproduction. See
`docs/audits/2026-06-13-claude-2.1.x-transcript-location.md`. Needs the
launcher internals (Jesse's domain).
