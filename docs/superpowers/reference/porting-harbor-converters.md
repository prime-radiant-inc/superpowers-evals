# Porting Harbor's log→ATIF converters (evergreen)

Harbor (the framework ATIF itself comes from) ships a per-agent Python converter
for every coding agent it supports: it reads that agent's native session log and
emits an ATIF `Trajectory`. Those converters encode the **hard, valuable part** —
the exact shape of each agent's log and where the tokens/tool-calls live — and
Harbor keeps them current as agent log formats drift.

We do **not** depend on them at runtime. We **port** them: translate Harbor's
log-format-parsing knowledge into TS-native normalizers (`src/normalize/<agent>.ts`)
that emit ATIF in **our** conventions. This doc is the recipe for the initial
port and for pulling Harbor's upstream updates over time.

This is the companion to `atif-normalizers.md` (what each of our normalizers does
and the disjoint-bucket / canonical-tool-name contract). Read that first — it is
the spec the port targets. This doc is the *how the port is produced* half.

## Why a port, not a runtime dependency

We evaluated vendoring / pip-installing Harbor's converters and rejected it:

- **548 MB of transitive deps** (litellm / openai / tiktoken / fastapi) for a
  zero-dependency TS harness.
- **Harbor's ATIF conventions are not ours.** Harbor emits **inclusive** token
  buckets (`prompt = input + cache_read + cache_creation`; see `claude_code.py`)
  and **native** tool names (`exec_command`, `function_call`, `spawn_agent` — no
  canonical `Bash`/`Edit`/`Agent`). Consuming Harbor at runtime would force a
  canonicalization layer between Harbor and obol.
- **The converter API is private and churny** (`_convert_events_to_trajectory`,
  `BaseInstalledAgent` coupling) — not a stable interface to build on.

A port avoids all of it: we keep the log-parsing knowledge, drop the framework,
and emit our disjoint buckets + canonical tool names + dedup **directly**. No
Python dep, no canonicalization layer, no obol change. The cost we accept in
exchange is **re-porting on upstream churn** — see "Sync workflow" and the honest
take at the end.

## The Harbor pin

Everything below is relative to a single pinned Harbor commit. The current pin:

```
repo:   https://github.com/laude-institute/harbor
commit: 5352049de712613e58459cad41afcf0bf8645738
version: 0.14.0   (pyproject.toml)
license: Apache-2.0
converters: src/harbor/agents/installed/<agent>.py
ATIF models: src/harbor/models/trajectories/
```

**Record the pin in code, not just here.** See "Recommended pin/manifest
mechanism" below. The pin is what makes `git diff <pin>..<new>` a meaningful
"what changed upstream" query.

## What we port vs. what we drop

Every Harbor converter is a `BaseInstalledAgent` subclass. Only a slice of it is
the log parser. Measured across the four representative converters:

| Harbor file | Total LOC | Portable parse logic | Droppable framework |
|---|---|---|---|
| `claude_code.py` | ~1419 | ~850 (60%) | ~570 (40%) |
| `codex.py` | ~867 | ~430 (50%) | ~440 (50%) |
| `acp.py` (generic) | ~1162 | ~400 (34%) | ~760 (66%) |
| `copilot_cli.py` | ~421 | ~135 (32%) | ~285 (68%) |

**Port** (the parse path):
- `_convert_events_to_trajectory` / `_convert_jsonl_to_trajectory` — the main
  loop that reads the JSONL and builds steps.
- `_convert_event_to_step`, `_extract_*`, `_parse_*`, `_build_metrics`,
  `_format_tool_result`, `_parse_output_blob`, helper text/arg extractors.
- The session-file glob *as a pattern to document*, not the discovery code
  (our capture layer already locates the log and hands the normalizer the raw
  string; see `src/capture/index.ts`).

**Drop** (the framework — obol prices, our pipeline drives):
- `install`, `run`, `exec_as_agent`/`exec_as_root`, version commands, CLI flag
  builders, MCP-config and skills-registration builders, auth resolution.
- `populate_context_post_run` (writes the file + back-propagates to Harbor's
  `AgentContext` — our `src/capture/` owns that).
- `_get_session_dir`/pathlib tree-walking discovery (our capture layer does
  cwd-filtered discovery already).
- **Anything that prices.** `codex.py`'s `_compute_cost_from_pricing`
  (lines ~302–353) imports `litellm` and applies a rate table — **drop it**.
  obol prices our `trajectory.json` downstream; the normalizer emits tokens
  only, and `cost_usd` only when the *log itself* records one (opencode, pi).

## Where Harbor's conventions become ours during the port

This is the load-bearing part. The port is *where we get correctness AND our
conventions* — we are not transcribing Harbor, we are re-expressing its parse
knowledge against our contract (`atif-normalizers.md`). Three translations
happen in every port:

### 1. Inclusive → disjoint token buckets

Harbor emits **inclusive** buckets. `claude_code.py` `_build_metrics`:

```python
prompt_tokens = input_tokens + cached_tokens + creation   # INCLUSIVE
```

Our contract is **DISJOINT** (`atif-normalizers.md`): `prompt_tokens` is the
**uncached** input, `cached_tokens` is cache-read, `step.extra.cache_write` is
cache-creation, `completion_tokens` folds in reasoning. So the port subtracts:

```ts
metrics.prompt_tokens = input_tokens;            // claude log input ALREADY excludes cache
metrics.cached_tokens = cache_read_input_tokens;
step.extra.cache_write = cache_creation_input_tokens;  // only when > 0
metrics.completion_tokens = output_tokens;       // + reasoning/thoughts where the log splits them
```

(For codex, whose *log* input includes cached, the port subtracts there instead:
`prompt = input − cached`, `cached → extra.total_cached_tokens`. See
`atif-normalizers.md` § codex — that disjoint correction is exactly the Harbor
inclusive→ours translation, already done in `src/normalize/codex.ts`.)

### 2. Native → canonical tool names

Harbor passes the agent's **native** tool name straight through as
`function_name` (verified in claude/codex/acp/copilot — none of them remap). The
port applies our reverse map (see `src/normalize/gemini.ts` `GEMINI_TOOL_MAP`,
`src/normalize/codex.ts` `CODEX_TOOL_MAP`):

- subagent dispatch (`spawn_agent`/`invoke_agent`/`task`/`subagent`) → `Agent`
- codex `exec_command` / `local_shell_call` → `Bash`; `apply_patch` → `Edit`
- gemini `run_shell_command`→`Bash`, `read_file`→`Read`, `replace`→`Edit`, …
- and **canonicalize the dispatch instruction to `prompt`** via
  `src/normalize/agent-prompt.ts` (codex/pi carry it under `task`).

### 3. Adopt Harbor's dedup, keep our buckets

**Key correctness lesson.** Harbor's claude converter **dedups re-emitted rows by
`message.id`** so streamed/compacted re-emissions don't double-count usage
(`claude_code.py` ~lines 717–765):

```python
last_usage_by_msg_id: dict[str, Any] = {}   # keep the LAST usage per id (streaming updates it)
...
if msg_id and msg_id in seen_message_ids:
    metrics = None                            # already counted this id — skip
else:
    usage = last_usage_by_msg_id.get(msg_id, message.get("usage"))
    metrics = self._build_metrics(usage)
    seen_message_ids.add(msg_id)
```

Our `src/normalize/claude.ts` now dedups by `message.id` (commit `9582dd9`, after
this bug inflated claude cost 1.4–2.3×) — it is the **reference implementation** of
this convention (`lastUsageByMessageId` + a `seenToolCallIds` guard). **A port
ADOPTS Harbor's dedup** (skip a second metrics emit for a seen `message.id`,
taking the *last* usage for that id) **while emitting OUR disjoint buckets.** That
is the whole thesis: the port is where we get both correctness and our contract.

> When you port a streaming/re-emitting agent's converter, this dedup is the
> single most important behavior to carry across. Add a regression test that feeds
> two assistant rows with the same `message.id` and asserts usage is counted once
> (see `test/normalize.claude.test.ts`).

## Per-converter assessment (at the pin)

| Converter | Harbor LOC | TS port LOC (parse only) | Complexity | LLM-assisted port | Notes |
|---|---|---|---|---|---|
| `claude_code.py` | ~1419 | ~700–800 | **moderate** | reliable w/ review (~70% first pass) | Stateful tool_use↔tool_result bundling + per-`message.id` usage dedup. Inclusive buckets → subtract. Native tool names. No nested subagent trajectories (it *filters out* `subagents/` dirs). Schema `ATIF-v1.7`. Carry the dedup. |
| `codex.py` | ~867 | ~350–450 | **moderate** | reliable w/ review | `response_item` payload state machine (`reasoning`/`message`/`function_call`/`*_output`/`web_search_call`); `pending_calls` join by `call_id`. Session-total usage from last `event_msg` `token_count.total_token_usage`; **input includes cached** (subtract). **Drop `_compute_cost_from_pricing` (litellm).** Native names → our `Bash`/`Edit`/`Agent` map. Stuffs `reasoning_output_tokens`/`total_tokens` in `final_metrics.extra` (we don't need them). |
| `copilot_cli.py` | ~421 | ~120–160 | **mechanical** | reliable | Flat per-event loop (`message`/`tool_use`/`tool_result`/`usage`). Buckets are bare `input_tokens`/`output_tokens` (no cache split at all). Schema `ATIF-v1.6`. **Caveat: this log format (`type:"tool_use"`/`"usage"`) differs from what our capture sees from current Copilot CLI (`assistant.message`/`session.shutdown`).** Confirm which format your captured trace is before porting — see "Format-drift caveat". |
| `acp.py` (generic) | ~1162 | ~450–550 | **moderate** | good for the loop, verify metrics | Generic ACP event state machine (`agent_thought_chunk`/`agent_message_chunk`/`tool_call`/`tool_call_update`/`usage_update`/`request_permission`) with `_AcpStepState`/`_AcpToolCallState`. Tool name from `kind`→`title`→`"tool"`. Usage `inputTokens`/`outputTokens` only (no cache), attached to last step; orphan usage collected to `extra`. Schema `ATIF-v1.6`. **NOT a base class** — zero Harbor agents subclass it, so porting it does **not** unlock multiple agents; it is one more standalone converter. |

General properties confirmed across all four: Harbor uses **inclusive** buckets,
**native** tool names, no `Agent` aliasing, no `cost_usd` except where the log
has one, and **does not build nested `subagent_trajectories`** in these
converters (claude explicitly skips `subagents/` dirs). The ATIF v1.7
`subagent_trajectories` field exists in the model but is unpopulated by these
parse paths — our normalizers likewise don't build it.

### Python idioms → TS equivalents (parse path only)

- **Harbor pydantic models** (`Step`, `ToolCall`, `Metrics`, `Observation`,
  `ObservationResult`, `FinalMetrics`, `Trajectory`) → our `src/atif/types.ts`
  interfaces. Field names mostly match (ATIF is the shared schema) **except our
  conventions**: Harbor's `Metrics.prompt_tokens` is inclusive, ours uncached;
  Harbor has no `step.extra.cache_write` convention. Map fields, don't copy.
- **`Trajectory(...)` construction + `.to_json_dict()`** → build the plain object
  and run it through `validateTrajectory` (`src/atif/validate.ts`), which enforces
  sequential `step_id`, `source_call_id` references, etc. — the same invariants
  Harbor's pydantic `model_validator`s enforce.
- **pathlib / `glob` / `rglob` discovery** → **drop**; our capture layer already
  hands the normalizer the raw log string. Document the glob *pattern* in the
  per-agent section of `atif-normalizers.md` instead.
- **`litellm` / pricing** → **drop**; obol prices.
- **`json.loads` per line** → split on `\n`, `JSON.parse` each, `try/catch`
  skip — exactly the house pattern (see every existing normalizer).
- **`isinstance(x, dict)` guards** → `typeof x === 'object' && x !== null &&
  !Array.isArray(x)` (see `normalizeGeminiToolCall`).
- **`@dataclass` state structs** (acp's `_AcpStepState`) → plain TS interfaces /
  objects.
- **`@override` / typing** → drop; TS interfaces cover it.

## The port recipe (programmatic / LLM-assisted)

Per converter, one pass:

**Inputs handed to the LLM:**
1. The pinned `src/harbor/agents/installed/<agent>.py`.
2. Our `src/atif/types.ts` (the target shape).
3. `docs/superpowers/reference/atif-normalizers.md` (the disjoint-bucket +
   canonical-tool-name + single-source contract).
4. The canonical tool-name map (the reverse maps in existing normalizers;
   `agent-prompt.ts` for the `task`→`prompt` rule).
5. Two or three existing normalizers (`claude.ts`, `codex.ts`, `gemini.ts`) as
   the house-pattern exemplar — same signature, same JSONL-split loop, same
   `validateTrajectory` tail.

**Outputs:**
- `src/normalize/<agent>.ts` exporting
  `normalize<Agent>(raw: string, version: string): AtifTrajectory`, matching the
  house interface (used by the dispatch table in `src/capture/index.ts`).
- `test/normalize.<agent>.test.ts` — **inline-fixture unit tests in the house
  style** (see below), not Harbor-style golden snapshots.

**State explicitly in the prompt:** the port targets **OUR disjoint buckets +
canonical tool names + per-`message.id` dedup**, **NOT** Harbor's inclusive
buckets / native names. The Python is the *log-shape oracle*; the conventions
come from `atif-normalizers.md`.

### What the tests actually look like (correction to "golden file")

Our normalizer tests are **not** golden-file snapshots. They are hand-built
inline-fixture unit tests (see `test/normalize.copilot.test.ts`,
`test/normalize.codex.test.ts`) that:
- build a tiny JSONL string in the test,
- assert `validateTrajectory(traj).errors` is `[]`,
- assert the **tool-name mapping** (`names` array equals the canonical sequence),
- assert **disjoint-bucket conservation** (sum of per-step `prompt + cached +
  completion + cache_write`, plus `final_metrics`, equals the known session
  total — no double-count, no dropped text-only turn),
- assert agent name/version and `schema_version === 'ATIF-v1.7'`.

A port's test must cover at minimum: tool-name canonicalization, the
disjoint-conservation invariant, the dedup-by-id regression (where applicable),
and `Agent`-alias + `prompt` canonicalization for the subagent tool.

## Worked example — `copilot_cli.py` (smallest converter)

Before (Harbor, the portable core — `_convert_jsonl_to_trajectory`, condensed):

```python
def _convert_jsonl_to_trajectory(self, jsonl_path):
    raw_events = self._read_copilot_cli_jsonl(jsonl_path)   # split lines, json.loads each
    step_id = 1; steps = []
    total_input = 0; total_output = 0
    for event in raw_events:
        et = event.get("type")
        if et == "message":
            role = event.get("role", "user")
            source = "agent" if role == "assistant" else "user"
            steps.append(Step(step_id=step_id, source=source,
                              message=event.get("content", "")))
            step_id += 1
        elif et == "tool_use":
            tc = ToolCall(tool_call_id=event.get("id",""),
                          function_name=event.get("name",""),       # NATIVE name
                          arguments=event.get("input",{}))
            steps.append(Step(step_id=step_id, source="agent",
                              tool_calls=[tc]))
            step_id += 1
        elif et == "tool_result":
            if steps and steps[-1].tool_calls:
                steps[-1].observation = Observation(results=[ObservationResult(
                    source_call_id=event.get("tool_use_id") or None,
                    content=event.get("content") or None)])
        elif et == "usage":
            inp = event.get("input_tokens", 0); out = event.get("output_tokens", 0)
            total_input += inp; total_output += out                 # INCLUSIVE, no cache split
            if steps and steps[-1].source == "agent":
                steps[-1].metrics = Metrics(prompt_tokens=inp, completion_tokens=out)
    return Trajectory(schema_version="ATIF-v1.6", ...,              # v1.6
        final_metrics=FinalMetrics(total_prompt_tokens=total_input or None,
                                   total_completion_tokens=total_output or None,
                                   total_steps=len(steps)))
```

After (TS sketch in OUR conventions — illustrative; do **not** wire this into the
pipeline as-is, our live Copilot capture uses a different log format, see the
caveat below):

```ts
import { ATIF_SCHEMA_VERSION, type AtifStep, type AtifToolCall,
         type AtifTrajectory } from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';
import { canonicalizeAgentPrompt } from './agent-prompt.ts';

// Native Copilot tool name → our canonical name.
const COPILOT_TOOL_MAP: Record<string, string> = {
  bash: 'Bash', view: 'Read', write: 'Write', edit: 'Edit',
  create: 'Write', rg: 'Grep', glob: 'Glob', task: 'Agent',
  update_todo: 'TodoWrite', web_fetch: 'WebFetch', web_search: 'WebSearch',
};

export function normalizeCopilot(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    if (ev['type'] === 'tool_use') {
      const tc: AtifToolCall = canonicalizeAgentPrompt({
        tool_call_id: (ev['id'] as string) ?? '',
        function_name: COPILOT_TOOL_MAP[ev['name'] as string] ?? (ev['name'] as string) ?? '',
        arguments: (ev['input'] as Record<string, unknown>) ?? {},
      });
      steps.push({ step_id: stepId++, source: 'agent', tool_calls: [tc] });
    } else if (ev['type'] === 'usage') {
      // OURS: disjoint. Copilot's `input_tokens` here has no cache split, so it
      // IS the uncached prompt; completion = output_tokens. (Real captured logs
      // may carry a cache_read field — subtract it into cached_tokens then.)
      const last = steps[steps.length - 1];
      if (last?.source === 'agent') {
        last.metrics = {
          prompt_tokens: (ev['input_tokens'] as number) ?? 0,
          completion_tokens: (ev['output_tokens'] as number) ?? 0,
        };
      }
    }
    // ...message / tool_result handling elided for the sketch...
  }
  if (steps.length === 0) steps.push({ step_id: 1, source: 'user', message: '' });

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,           // OURS: v1.7, not Harbor's v1.6
    agent: { name: 'copilot', version },
    steps,
  };
  const r = validateTrajectory(traj);
  if (!r.ok) throw new Error(`normalizeCopilot produced invalid ATIF: ${r.errors.join('; ')}`);
  return traj;
}
```

The diff between the two columns *is* the convention translation: native name →
`COPILOT_TOOL_MAP`/`Agent`; `ATIF-v1.6` → `ATIF_SCHEMA_VERSION` (v1.7); inclusive
buckets stated/subtracted to disjoint; pydantic `Trajectory(...)` →
plain object + `validateTrajectory`; pathlib/file-read dropped (raw string in).

> **Format-drift caveat (real, not hypothetical).** Harbor's `copilot_cli.py` at
> this pin parses a `type:"message"`/`"tool_use"`/`"tool_result"`/`"usage"`
> event stream. Our shipped `src/normalize/copilot.ts` parses a
> `assistant.message`/`session.shutdown` stream — a **different** Copilot log
> layout (because our capture and Harbor's capture invoke the CLI with different
> output settings). **A Harbor converter parses the log Harbor's capture
> produces, which is not always the log our capture produces.** Always diff the
> Harbor parse target against a real captured trace before porting (next section)
> — the parse logic is only reusable to the extent the two capture formats agree.

## Validation — parity against a real captured trace

Each ported converter must pass a **parity test against a REAL captured trace**,
not just inline fixtures. The oracle is the parity harness already built at
`/tmp/harbor-spike/`:

```
/tmp/harbor-spike/
  venv/        # Harbor installed (the oracle)
  parity.py    # convert one captured log via Harbor AND read our trajectory.json, diff
  spike.py     # the single-converter summarizer parity.py grew out of
```

`parity.py` (claude/codex today; extend per converter) does:

```
parity.py <converter> <session_dir> <ours_trajectory.json> [model]
```

- **Harbor side (oracle):** instantiates the pinned converter and runs
  `_convert_events_to_trajectory(session_dir)` over the captured `*.jsonl`.
- **Ours (under test):** loads the `trajectory.json` our normalizer produced.
- **Asserts:** tool histogram + step count match, and — after reconciling
  Harbor's *inclusive* `final_metrics` down to disjoint
  (`uncached = prompt − cached − cache_create`) — the disjoint token sums match
  ours bucket-for-bucket. **Harbor = oracle, our TS normalizer = under test.**

Get a real trace from a prior run: `results/<run>/home/...` (per the per-run
throwaway `$HOME`, e.g. `.claude`/`.codex`), which is the same captured log our
`src/capture/` normalized. Point Harbor's converter at that directory and our
`trajectory.json` from `results/<run>/.../trajectory.json`.

A new converter graduates from "ported" to "trusted" only when (a) its
inline-fixture unit test passes `bun test test/normalize.<agent>.test.ts` and
(b) `parity.py` shows disjoint-token + tool-structure parity on a real trace.

## Recommended pin/manifest mechanism

Record the pin in **one** place plus a per-file attribution header:

**1. A `HARBOR_PIN` manifest** — a single source of truth next to the
normalizers. Suggested: `src/normalize/harbor-pin.ts`:

```ts
// Harbor pin for the ported log→ATIF converters. Bump only after re-porting the
// affected normalizers and re-running their parity tests. See
// docs/superpowers/reference/porting-harbor-converters.md.
export const HARBOR_PIN = {
  repo: 'https://github.com/laude-institute/harbor',
  commit: '5352049de712613e58459cad41afcf0bf8645738',
  version: '0.14.0',
  // Per-converter: the Harbor commit each normalizer was last ported from.
  // Lets `git diff <ported>..<pin>` be scoped per converter when they drift apart.
  ported: {
    claude:      '5352049de712613e58459cad41afcf0bf8645738',
    codex:       '5352049de712613e58459cad41afcf0bf8645738',
    copilot:     '5352049de712613e58459cad41afcf0bf8645738',
    gemini:      '5352049de712613e58459cad41afcf0bf8645738',
    opencode:    '5352049de712613e58459cad41afcf0bf8645738',
    pi:          '5352049de712613e58459cad41afcf0bf8645738',
    kimi:        '5352049de712613e58459cad41afcf0bf8645738',
    antigravity: '5352049de712613e58459cad41afcf0bf8645738',
  },
} as const;
```

A per-converter `ported` map (not just one global pin) is worth the few lines:
converters drift independently, and you re-port one at a time, so each needs its
own "last ported from" marker to scope its diff.

**2. A per-file attribution header** on each ported `src/normalize/<agent>.ts`
(also satisfies the Apache-2.0 attribution requirement — see below):

```ts
// Ported from Harbor's src/harbor/agents/installed/<agent>.py
//   repo:   https://github.com/laude-institute/harbor (Apache-2.0)
//   commit: 5352049de712613e58459cad41afcf0bf8645738 (v0.14.0)
// Log-parsing logic is derived from Harbor; token buckets, tool-name
// canonicalization, and message-id dedup follow OUR conventions
// (docs/superpowers/reference/atif-normalizers.md), NOT Harbor's.
```

The header is the human-readable record; `harbor-pin.ts` is the machine-readable
one the sync workflow diffs against. Keep them in sync (the per-file commit
should equal the `ported.<agent>` entry).

## Sync workflow — pulling and re-porting upstream updates

Periodically (and before any campaign that leans on cost data), reconcile with
Harbor:

**1. Fetch and diff.**

```bash
cd /tmp/harbor-inspect          # or wherever the Harbor clone lives
git fetch origin
NEW=$(git rev-parse origin/main)
PIN=5352049de712613e58459cad41afcf0bf8645738   # from harbor-pin.ts

# Per-converter parse-path diff:
git diff $PIN..$NEW -- src/harbor/agents/installed/claude_code.py
git diff $PIN..$NEW -- src/harbor/agents/installed/codex.py
# ...one per agent we port...

# ATIF schema diff (see "Detecting ATIF-schema changes"):
git diff $PIN..$NEW -- src/harbor/models/trajectories/
```

**2. Triage which converters changed.** Ignore diffs that touch only the
droppable framework (install/run/CLI/MCP/auth) — those don't affect the parse.
Re-port only converters whose `_convert_*`/`_parse_*`/`_extract_*`/`_build_metrics`
parse path changed.

**3. Re-port the changed ones (LLM-assisted), feeding the diff.** Run the port
recipe above, but additionally hand the LLM the `git diff` hunk and the existing
`src/normalize/<agent>.ts`, with the instruction: *apply this upstream parse-logic
change to our normalizer, preserving our disjoint buckets / canonical names /
dedup.* Smaller, safer than a from-scratch re-port.

**4. Re-run validation.** `bun test test/normalize.<agent>.test.ts` and
`parity.py <converter> <real-trace-dir> <ours-trajectory.json>` for each
re-ported converter.

**5. Bump the pin.** Update `harbor-pin.ts` (the global `commit` and the touched
`ported.<agent>` entries) and the per-file attribution headers. Note the bump in
a dated `docs/experiments/` entry per the experiment-log convention.

### Adding a NEW agent

Same recipe, fresh: port the agent's Harbor converter from scratch (Inputs 1–5
above), add `src/normalize/<agent>.ts` + its test, register it in the dispatch
table in `src/capture/index.ts`, add the `ported.<agent>` entry to
`harbor-pin.ts`, and validate against a real captured trace. If the agent uses
Harbor's generic `acp.py` path, port `acp.py` (it's standalone — porting it does
not transitively cover other agents).

### Detecting upstream ATIF-schema changes

Token-bucket / tool-name drift is per-converter; **schema** drift is global and
more dangerous. Watch two things in the diff:

- **`git diff $PIN..$NEW -- src/harbor/models/trajectories/`** — new/renamed
  fields, a new `schema_version` literal (the `Literal[...]` in `trajectory.py`),
  changed validators. A new ATIF minor (e.g. `ATIF-v1.8`) means our
  `src/atif/types.ts` `ATIF_SCHEMA_VERSION` and `validate.ts` may need updating
  before any re-port that emits the new version.
- **Harbor's RFC / CHANGELOG** for ATIF (RFC 0001 etc.) — the human rationale for
  a schema bump. ATIF "has had breaking changes across minors" (noted in
  `src/atif/types.ts`); treat a minor bump as a real migration, not a no-op
  string change.

## Attribution (Apache-2.0)

Harbor is Apache-2.0. The ports are **derivative works** of Harbor's parse logic.
Each ported `src/normalize/<agent>.ts` MUST carry the attribution header shown
above (credit Harbor, the repo URL, the Apache-2.0 license, and the pinned
commit it was ported from). This both satisfies the license's attribution
requirement and tells the next maintainer exactly which upstream commit to diff
against when syncing.

## Honest take — is a programmatic port the right strategy?

**Yes, for our constraints — with eyes open about the maintenance tail.**

For:
- It is the only option consistent with a **zero-dependency** TS harness; the
  runtime-vendor path costs 548 MB of litellm/openai/tiktoken/fastapi.
- It buys **correctness we don't otherwise have** (Harbor's `message.id` dedup
  fixes our claude double-count) *while* keeping our disjoint-bucket + canonical
  -name contract that obol and the transcript checks depend on. Vendoring would
  force a canonicalization shim between Harbor and obol and *still* leave the
  inclusive-bucket mismatch to translate.
- The parse logic is **self-contained and deterministic** — no ML, no network,
  no async in the parse path — so LLM-assisted porting is genuinely reliable
  (mechanical for copilot; moderate-with-review for claude/codex/acp), and the
  parity harness gives an objective oracle to catch a bad port.

Against / costs to be honest about:
- **Re-porting is a recurring tax.** Every upstream parse-logic change is a
  manual (LLM-assisted) re-port + re-validate. The per-converter `ported` pin and
  the framework-vs-parse triage keep it bounded — most upstream churn is in the
  droppable framework — but it is not free, and a schema (ATIF minor) bump is a
  real migration.
- **Format drift is the sharp edge, not LOC.** Harbor's converter parses *Harbor's*
  captured log; ours parses *our* captured log. Where the two capture layers
  invoke the CLI differently (copilot is a live example), the Harbor parse logic
  is only a *reference*, not a drop-in. The port's value is the log-shape
  knowledge, which still has to be validated against *our* trace every time.
- **acp.py does not pay off as "broad coverage."** It's a standalone converter,
  not a base class with subclasses, so porting it covers exactly one agent.

Net: port for the converters we actually run, pin per-converter, validate every
port against a real trace, and budget for periodic re-ports. Don't port the long
tail of Harbor converters for agents we don't test — that's all maintenance cost
and no coverage benefit. The runtime-vendor path was correctly rejected; the port
is the right call, provided the pin/manifest + parity discipline above is kept.
```
