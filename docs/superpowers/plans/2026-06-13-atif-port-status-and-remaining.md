# ATIF port — status & remaining work (handoff)

Branch: `feat/atif-port` (pushed). As of 2026-06-13, built autonomously while
Jesse was out. **Nothing live was cut over** — the Python harness + shell check
tools run unchanged; all new code is additive under `ts/` (isolated, tested).

## DONE (built, tested, reviewed)

A complete, self-contained ATIF v1.7 pipeline in `ts/` (bun, zero runtime deps),
**115 tests pass, `tsc --noEmit` clean**, two-stage reviewed (final review by
opus: "ready to continue", high fidelity to the shell originals):

- `ts/src/atif/types.ts` — ATIF v1.7 interfaces, pinned `schema_version`.
- `ts/src/atif/validate.ts` — structural validator (schema_version, sequential
  step_id, agent-only-field scoping, same-step `source_call_id`, dup tool ids).
- `ts/src/normalize/claude.ts` — Claude Code session log → ATIF. **Validated
  against a REAL claude 2.1.177 transcript** (handles string- and array-form
  message content; ignores `queue-operation`/`attachment`/`ai-title` rows).
- `ts/src/atif/project.ts` — `flattenToolCalls` → ordered `{tool,args}[]`.
- `ts/src/detect/{skill,implementation}.ts` — faithful TS ports of
  `bin/_skill_predicate.jq` and `bin/_implementation_path.jq`.
- `ts/src/check/{record,transcript,verbs}.ts` + `ts/src/cli/check-transcript.ts`
  — the `check-transcript <verb>` CLI. Record output is byte-compatible with
  `bin/_record` (`{check,args,negated,passed,detail}`). The C1 empty-capture
  guard is preserved (negative assertions FAIL on empty/missing transcript).
- **End-to-end proven**: real claude transcript → `normalize-claude` → ATIF →
  `check-transcript` verbs produce correct pass/fail records, and a missing
  transcript correctly fails negative assertions.

**Verbs ported (12):** tool-called, tool-not-called, tool-count, tool-before,
skill-called, skill-not-called, skill-before-tool, skill-before-implementation-tool,
implementation-tool-not-called, investigated, worktree-created,
tool-match-before-tool-match.

## CORRECTION: B1 (claude capture) root cause was wrong

Reproduction (Task 7, see `docs/audits/2026-06-13-claude-2.1.x-transcript-location.md`)
**refuted** the "claude moved to `sessions/history.jsonl`" hypothesis. claude
2.1.177 writes the legacy `projects/<munged>/<uuid>.jsonl` — exactly where the
harness globs. B1 is a bug in **how quorum/gauntlet launches claude** (a direct
`claude -p` persists the transcript; the quorum run did not). The **2.1.175 pin
may not fix it** — never verified with a real `quorum run --coding-agent claude`.
Separate, higher-priority bug; needs the launcher internals (Jesse's domain).

## REMAINING (the 2b cutover — NOT done; needs review/decisions)

1. **Other-agent normalizers** (`codex`, `gemini`, `copilot`, `opencode`, `pi`,
   `antigravity`, `kimi` → ATIF). Mechanical — port from `quorum/normalizers.py`
   (`normalize_codex_logs` etc.). They only need to populate
   `step.tool_calls[].function_name`/`arguments` + string/array `message`; the
   predicates already key off codex/antigravity arg shapes (`cmd`,
   `LocalShellCall`, alternate path aliases). Watch the validator's strict
   `step_id`/agent-only rules for interleaved subagent logs.

2. **Runner integration** (Python side). The runner must emit `trajectory.json`
   and set `QUORUM_TRANSCRIPT_PATH` for `check-transcript`. Decide how: Python
   shells out to `bun run normalize-<agent>` to produce ATIF from the captured
   session log. NOTE: `loadCalls()` currently treats *any* read/parse failure as
   `empty:true` — fine for the negative-assertion contract, but a genuinely
   corrupt trajectory is then indistinguishable from "no transcript". Add a
   distinct diagnostic before this is load-bearing.

3. **Scenario caller migration (~50 `checks.sh`).** Rewrite `skill-called X` →
   `check-transcript skill-called X` **only for the 12 ported verbs**. A naive
   sed WILL break: `skill-before-tool-match`, the `not` wrapper, `tool-arg-match`,
   and the non-capture-family checks (`file-exists`, `git-*`, `*-plugin-installed`)
   must stay on the shell tools (`check-transcript` exits 2 on un-ported verbs).
   Allow-list the 12 explicitly.

4. **DECISION NEEDED — `tool-arg-match` contract.** The shell version takes an
   arbitrary jq expression (`tool-arg-match Read '.path == "X"'`), used by ~6
   scenarios. There's no jq in the TS world. Options: (a) a small safe
   expression DSL; (b) JSONPath/structured matchers; (c) a fixed set of
   `--arg-equals key=value` / `--arg-matches key=regex` flags and rewrite the
   callers. Until decided, those scenarios keep using the shell `tool-arg-match`.

## Suggested next order
B1 launch bug (claude is the primary agent and currently unevaluable) →
runner integration (so ATIF is actually produced) → codex normalizer + a few
scenarios as a migration pilot → decide `tool-arg-match` → full caller migration.
