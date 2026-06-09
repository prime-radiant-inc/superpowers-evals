# 2026-06-09 — Kimi tool-result-bloat capture + surfacing (SUP-329)

## Problem

`quorum/token_usage.py:parse_kimi_wire` hardcodes `"tool_result_total_bytes": 0`
(line ~420). It only sums `usage.record` token rows and never measures the byte
size of tool-result payloads, so the persisted value is always `0` for kimi
(claude and codex compute it for real). And separately, **no backend surfaces
this number anywhere** — it's written into `coding-agent-token-usage.json` and
never read, so even the real values for claude/codex are invisible.

Linear: SUP-329. Surfaced in the 2026-06-09 codex+kimi matrix
(`batch-20260609T054908Z-8e3a`); triage in the kimi sweep doc
`docs/baselines/kimi-sweeps/2026-06-09.md` (which lands via the baselines branch
`docs/codex-kimi-sweeps-2026-06-09`).

## What this does

The point is to **track and read tool-result bloat**. Two small parts:

1. **Compute** the kimi byte total correctly (replace the hardcoded `0`).
2. **Surface** it where cost is read (the economics output), so the number is
   actually visible instead of buried in a JSON file.

A prior draft added a runtime "drift guard" with new verdict-schema plumbing; a
design review showed it guarded a number nothing displayed, defended the
least-likely failure mode, and carried a false-positive. **It's dropped.** Making
the number *visible* is simpler and is its own drift signal — a run with tool
calls showing `0` bytes is obviously wrong to anyone looking.

## Goal / non-goals

**Goal:** compute `tool_result_total_bytes` for kimi with **parity** to the codex
parser, and surface it in the economics output for all backends that produce it.

**Non-goals:** SUP-328 (model-id / pricing); a deterministic bloat-grading *check*
(reading the number in `checks.sh` to pass/fail a scenario) — that's a separate
decision tied to the `cost-*` triage; the cross-harness DRY pass. No runtime
guard, no verdict-schema/warning field.

## Verified wire schema

From the kimi `results/` corpus (111 `wire.jsonl` files, 1,313 tool-result
events; the cost-bloat and 38-file SDD runs are the deepest examples):

- Tool results are `type == "context.append_loop_event"` records whose
  `event.type == "tool.result"`.
- Payload path: **`record["event"]["result"]["output"]`**, a **flat UTF-8 string
  in 100% of observed cases** (never a content-block list like claude's).
- `event.result.isError` (bool) appears on ~111/1,313 results; those still carry
  their full payload in `output`.
- **No truncation:** no wire-level truncation markers; the largest payloads carry
  an honest in-band tool-side cap ("Max 1000 lines reached"), so the byte length
  equals what the model saw.

## Design

### Part 1 — compute the bytes in `parse_kimi_wire`

The current loop fuses two guards on one line
(`if not isinstance(row, dict) or row.get("type") != "usage.record": continue`),
so the new branch can't simply go "before" it — split the `isinstance` guard out
first, and accumulate in the **row-collection loop** (the `tool.result` rows are
not `usage.record` rows and are dropped before the selected-row loop runs):

```python
try:
    row = json.loads(line)
except json.JSONDecodeError:
    continue
if not isinstance(row, dict):
    continue
rtype = row.get("type")
if rtype == "context.append_loop_event":
    event = row.get("event")
    if isinstance(event, dict) and event.get("type") == "tool.result":
        result = event.get("result")
        if isinstance(result, dict):
            output = result.get("output")
            if isinstance(output, str):
                tool_result_total_bytes += len(output.encode("utf-8"))
    continue
if rtype != "usage.record":
    continue
# ... existing usageScope turn/session bucketing unchanged ...
```

Initialize `tool_result_total_bytes = 0` alongside `turn_rows`/`session_rows`, and
replace the hardcoded `0` in the return dict with the accumulator.

**Decisions (both = parity with codex):** count `isError` results (bytes the
model ingested; codex/claude count them too); inline the computation (mirrors
codex at `token_usage.py:311`, no shared helper — the DRY pass owns that).

**Scope:** `parse_kimi_wire` runs once per `wire.jsonl`; `capture_tokens` already
sums `tool_result_total_bytes` across all subagent wires (line ~481), uniformly
with claude/codex. No new wiring in the parser path.

### Part 2 — surface it in the economics output

`tool_result_total_bytes` already lives in the usage dict
(`coding-agent-token-usage.json`); it's just dropped on the way to the verdict and
never rendered. Two small additions, no new schema:

- **`quorum/economics.py:_coding_block`** (~L64-98) — copy `tool_result_total_bytes`
  from the usage dict into the coding-agent economics block (it already carries
  `duration_ms`, `model`, `tokens`, `est_cost_usd`, etc.; this is one more key in
  the existing dict, so it flows into `verdict.json` economics with no dataclass
  change).
- **`quorum/show.py:_format_economics_pane`** (~L216-236) — render the byte total
  as a line/column in the economics pane (human-readable, e.g. KB).

This makes the metric tracked and read for **every** backend that computes it
(claude/codex/kimi), not just kimi. Backends without a token parser
(`capture_tokens` returns `None`) simply have no economics block, unchanged.

## Testing

**Unit (Part 1), inline-JSONL in `tests/quorum/test_token_usage.py::TestParseKimiWire`:**
- `test_sums_tool_result_bytes` — `tool.result` rows with known-length `output`;
  include a multibyte char (prove *bytes* not chars) and one `isError` result
  (prove errors counted); assert the exact UTF-8 byte sum.
- edge cases — non-string / missing / empty `output` → 0; a wire with no tool
  results → `0`, no error.

**Regression fixture (Part 1):** a small fixture derived from a real kimi capture,
preserving the real record structure and key paths (a few records incl. one
`isError`), asserting the byte total over its outputs. Catches *us* breaking the
parser. (It can't catch production kimi changing its format — but Part 2 makes
such a regression visible, which is the practical backstop.)

**Surfacing (Part 2):** a test that a usage dict with a non-zero
`tool_result_total_bytes` flows through `_coding_block` into the economics block,
and that `_format_economics_pane` renders it.

## Risks

The byte path walks reverse-engineered, undocumented kimi wire keys; if kimi
renames an event or nests `output`, the `isinstance(output, str)` guards miss and
the total drifts (toward 0 for a full break, or an undercount for a partial one).
This brittleness is consistent with the rest of `token_usage.py` (every parser
hardcodes its format's keys).

Mitigations, in order of practical value: (1) the metric is now **rendered**, so a
regression — especially the obvious all-zero case — is visible to anyone reading a
run's economics; (2) the regression fixture catches us breaking the parser
ourselves. Residual: a *partial* undercount (a future structured/error `output`
shape silently dropped by the `isinstance` guard) is less visually obvious than an
all-zero — acceptable given 100% flat-string in the current corpus, and noted as
the thing to watch if kimi's result schema ever gains structure.
