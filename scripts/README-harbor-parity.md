# harbor-parity — validation harness

`scripts/harbor-parity.ts` is a **dev-only oracle runner** that compares our
TypeScript normalizers against Harbor's reference converter for a captured
session log. It is not wired into `bun run check`.

## When to use it

- After modifying a normalizer (`src/normalize/<agent>.ts`) to verify your
  changes produce the same tool-call histogram and token totals as Harbor.
- When investigating a token-count discrepancy in a real run.
- As the Step 4 parity check specified in the full-fidelity ATIF upgrade plan
  (`sdd/task-1-brief.md` and later task briefs).

## Prerequisites

Harbor's Python venv must be present at `/tmp/harbor-spike/venv`:

```sh
# If missing, recreate it:
uv venv --python 3.12 /tmp/harbor-spike/venv
uv pip install --python /tmp/harbor-spike/venv harbor==0.14.0
```

Harbor source reference (for reading its converter logic) is at
`/tmp/harbor-inspect` (pinned commit `5352049de712613e58459cad41afcf0bf8645738`).

## Usage

```
bun scripts/harbor-parity.ts <agent> <session-log-dir>
```

**`<agent>`** — one of: `claude`, `codex`, `gemini`, `opencode`, `copilot`,
`kimi`, `pi`, `antigravity`

**`<session-log-dir>`** — directory containing the agent's session log(s).
The exact path depends on the agent:

| Agent | Session log dir (relative to the run dir) |
|---|---|
| claude | `home/.claude/projects/<slug>/` |
| codex | `home/.codex/` (or wherever codex writes rollout logs) |
| gemini | `home/.gemini/` (or wherever gemini writes chats) |
| opencode | `home/.quorum/session-exports/` |
| copilot | agent-specific path; check `coding-agents/copilot.yaml` |
| kimi | agent-specific path; check `coding-agents/kimi.yaml` |
| pi | agent-specific path; check `coding-agents/pi.yaml` |
| antigravity | `home/brain/<uuid>/.system_generated/logs/` |

### Claude example

```sh
bun scripts/harbor-parity.ts claude \
  results/superpowers-bootstrap-claude-20260616T052827Z-bf6f/home/.claude/projects/-workspace-evals-results-superpowers-bootstrap-claude-20260616T052827Z-bf6f-coding-agent-workdir/
```

Shell glob expansion works too — handy when the project slug is long:

```sh
bun scripts/harbor-parity.ts claude \
  results/superpowers-bootstrap-claude-*/home/.claude/projects/*/
```

## Known divergence: codex `unified_exec` logs

Codex rollouts produced with `unified_exec` (default for gpt-5.6-family
models) record one `exec` custom_tool_call per JavaScript script. Harbor keeps
that call verbatim; our normalizer unpacks it into canonical calls
(`Bash`/`Edit`/`update_plan`/…), one per `tools.*` invocation, per
`docs/atif-unified-exec-convention.md`. The tool-call histograms therefore
disagree **by design** on such logs: Harbor reports N × `exec`, we report the
unpacked vocabulary. To compare, group our calls by `extra.composite_call_id`
— the groups must correspond 1:1 with Harbor's `exec` calls. Token buckets are
unaffected.

## Output

The tool prints three sections:

1. **OUR NORMALIZER** — step count, tool-call histogram, content fields
   populated, and per-step disjoint token sums.
2. **HARBOR CONVERTER** — same, plus Harbor's `final_metrics` displayed in
   both inclusive and disjoint form.
3. **PARITY CHECK** — side-by-side of tool-call counts + histogram, and
   token-bucket comparison of our per-step sums against Harbor's
   `final_metrics` translated to disjoint buckets.

## Token-bucket convention

Harbor's `final_metrics` uses **inclusive** prompt buckets where
`total_prompt_tokens = uncached + cached + cache_creation`. Our ATIF
convention uses **disjoint** buckets (no overlap). The `disjointFromHarbor`
helper (exported from `scripts/harbor-parity.ts`) performs the translation:

```
uncached    = total_prompt_tokens − total_cached_tokens − total_cache_creation_input_tokens
cached      = total_cached_tokens
cache_write = total_cache_creation_input_tokens   (from extra)
completion  = total_completion_tokens
```

These values are validated against the claude bf6f trace:
Harbor → 94269 / 71457 / 17118 / 528 (inclusive)
Disjoint → 5694 / 71457 / 17118 / 528 ✓

## Running the unit test

The `disjointFromHarbor` helper has a unit test in `test/harbor-parity.test.ts`
(included in `bun run check`):

```sh
bun test test/harbor-parity.test.ts
```
