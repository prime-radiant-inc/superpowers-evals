# Grok Build Quorum Target - design specification

**Status:** Approved direction, amended after staff review. Awaiting final
review before implementation planning.
**Date:** 2026-06-19
**Context:** Quorum has first-class targets for Claude, Codex, Gemini, Kimi,
OpenCode, Pi, Copilot, and Antigravity. Drew wants a first-class `grok` target
for xAI Grok Build, with apples-to-apples behavior against the existing
Coding-Agent harnesses. Grok has no Harbor converter, so the normalizer must be
reverse-engineered from captured Grok logs.

---

## Goal

Add `grok` as a first-class Quorum Coding-Agent target.

The target should:

- run normal Grok Build CLI operation, not a special model-mode experiment;
- load Superpowers from the local `SUPERPOWERS_ROOT`;
- drive Grok from the same Gauntlet-backed Quorum flow as other targets;
- normalize Grok session logs into ATIF `trajectory.json`;
- capture Grok token usage through Quorum's ATIF economics path;
- keep raw secret-bearing Grok debug logs out of run artifacts;
- appear as `--coding-agent grok`, a matrix column, a run directory suffix, and
  a `# coding-agents: grok` directive value.

Expected maintainer command shape:

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
export XAI_API_KEY=...
bun run quorum run scenarios/00-quorum-smoke-hello-world \
  --coding-agent grok \
  --out-root results/grok-smoke
```

## Non-goals

- Using ACP/headless mode as the baseline. Quorum should test normal user
  operation unless a later design deliberately adds a Grok variant.
- Defaulting to `--agent grok-build-plan` or `-m grok-build`. Phase 0 showed
  those flags can work, but normal Grok CLI operation is plain `grok`.
- Building a bespoke Grok price table in evals. Cost is either native exact
  cost from Grok/xAI or obol pricing over ATIF token buckets.
- Shipping Windows support in v1. Grok supports PowerShell install, but Quorum
  does not yet have a Grok Windows runner/provisioner path.
- Depending on a committed Grok Superpowers manifest before it exists.
  SUP-384 tracks adding a first-class Grok plugin manifest to the Superpowers
  repo. Quorum v1 can use `[plugins].paths` against `SUPERPOWERS_ROOT`.
- Capturing raw Grok debug logs as artifacts. Live verification showed they
  contain auth-looking material.

## Target Configuration

Add `coding-agents/grok.yaml`:

```yaml
name: grok
binary: grok
session_log_dir: "${QUORUM_AGENT_HOME}/.grok/sessions"
session_log_glob: "**/chat_history.jsonl"
normalizer: grok
home_config_subdir: ".grok"
required_env:
  - XAI_API_KEY
  - SUPERPOWERS_ROOT
max_time: 10m
os_support: [linux]
```

`grok` is a new runtime family and normalizer. It should not reuse the generic
ACP normalizer because the baseline is the Grok TUI/CLI surface and because the
session files already contain the transcript shape Quorum needs.

Registration work is part of the target, not incidental plumbing. The
implementation must add Grok to:

- `KNOWN_RUNTIME_FAMILIES` in `src/contracts/agent-config.ts`
- `CUSTOM_AGENTS` / `resolveAgent` in `src/agents/index.ts`
- `NORMALIZERS` in `src/capture/index.ts`
- `STRICT_CAPTURE_NAMES` in `src/runner/index.ts`
- cwd filtering in `src/capture/cwd-filter.ts`
- bootstrap/check-tool dispatch where target-specific installed checks live
- context population so `coding-agents/grok-context/launch-agent` is required
  and missing launch substitutions fail before the eval starts

## Auth

The v1 target is API-key-first. Quorum should require `XAI_API_KEY` so shared
auth and remote eval runs do not depend on a copied OAuth browser login.

Local Grok docs say auth priority is active session token first, then
`XAI_API_KEY` fallback. The implementation should make API-key auth explicit in
the isolated run home by ensuring no host `~/.grok/auth.json` is copied into
`QUORUM_AGENT_HOME`. A live smoke with only `XAI_API_KEY` is an acceptance gate.

`XAI_API_KEY` should not be passed to Grok by relying on ambient tmux or
Gauntlet environment inheritance. `GrokAgent.provision` should read the already
validated host env value, create a run-scoped private temp directory outside the
run artifact root, and write a mode-0600 shell env file containing only the
Grok runtime secrets needed by `launch-agent`. The launcher should source that
file immediately before `exec grok`.

If the current runner would expose `XAI_API_KEY` to Gauntlet through a broad
host environment snapshot, the Grok implementation must add a narrow redaction
or withhold path so the key is visible only to the Grok launcher process. The
key must not appear in Gauntlet prompts, context files, verdicts, trajectory
artifacts, token sidecars, captured stderr, or provisioning diagnostics.

The local Phase 0 machine did not have `XAI_API_KEY` in the shell, so API-key
auth remains an implementation acceptance check, not a resolved Phase 0 proof.

## Superpowers Provisioning

Quorum should seed the isolated Grok home with a minimal Grok config:

```toml
[plugins]
paths = ["${SUPERPOWERS_ROOT}"]
```

This was verified in an isolated home: `grok inspect --json` discovers the core
Superpowers skills directly from the checkout when `plugins.paths` points at
`SUPERPOWERS_ROOT`.

Do not run `grok plugin install "$SUPERPOWERS_ROOT" --trust` in v1. It attempts
to copy the whole checkout and failed during Phase 0 on
`.git/fsmonitor--daemon.ipc`.

Do not install existing sidecar manifests such as `.codex-plugin` or
`.kimi-plugin` as a Grok plugin. They validate as manifests and install a
plugin shell, but isolated probes showed they expose zero Superpowers skills to
`grok inspect --json` because those directories do not contain the repo
`skills/` tree.

Provisioning should verify `grok inspect --json` exposes at least:

- `using-superpowers`
- `brainstorming`
- `test-driven-development`
- `writing-plans`

If any required skill is absent, provisioning should fail with a Grok-specific
diagnostic before the expensive live eval starts.

Phase 0 proved `[plugins].paths` gives skill discovery. It did not prove path
plugins are enabled/trusted installed plugins, and isolated probes reported no
hooks through that path. That is acceptable for v1 because Quorum scenarios
verify Superpowers through skill-file reads and transcript checks. If a later
scenario depends on Grok hooks, project trust, or session-start behavior, that
needs a separate manifest/trust design and should not be inferred from
`plugins.paths`.

SUP-384 tracks adding a proper first-class Grok plugin manifest/package to the
Superpowers repo. When that lands, Quorum can switch from direct
`plugins.paths` to the supported repo-level Grok manifest if it gives the same
skill visibility without copying unrelated repo internals.

## Launcher

The launcher should run Grok in normal interactive CLI mode from the run workdir:

```bash
cd "$QUORUM_AGENT_CWD"
: "${GROK_ENV_FILE:?}"
: "${GROK_DEBUG_FILE:?}"
set -a
. "$GROK_ENV_FILE"
set +a
exec env $QUORUM_HOME_ENV \
  grok --cwd "$QUORUM_AGENT_CWD" \
    --always-approve \
    --no-alt-screen \
    --no-auto-update \
    --debug-file "$GROK_DEBUG_FILE" \
    "$@"
```

`--no-auto-update` was accepted by local `grok 0.2.56` even though it is not
shown in the top-level help. It keeps eval runs from changing the CLI while a
batch is in flight.

The launcher should not set `--agent`, `--model`, or `-m` by default. If a
future target variant wants a pinned Grok model or agent profile, it should add
a separate target name and explicit design, not mutate baseline `grok`.

`grok-context` is required for v1 because it owns the private env-file and
debug-file substitutions. Context population should fail if `launch-agent`
contains unresolved Grok placeholders such as `$GROK_ENV_FILE` or
`$GROK_DEBUG_FILE`, or if either resolved path is missing. `GROK_DEBUG_FILE`
must point outside the run artifact tree.

## Transcript Capture

Grok writes session directories under:

```text
${QUORUM_AGENT_HOME}/.grok/sessions/<encoded-cwd>/<session-id>/
```

Phase 0 captured `chat_history.jsonl` rows with these observed types:

- `system`
- `user`
- `reasoning`
- `assistant`
- `tool_result`

Use `chat_history.jsonl` as the transcript source. Other session files are not
the transcript source for v1:

- `updates.jsonl` carries ACP update events and `_meta.totalTokens` context
  counters, but not billable usage buckets.
- `signals.json` carries context-window/session counters, not billable usage
  buckets.
- `summary.json` carries session metadata such as `current_model_id`.
- `events.jsonl` carries lifecycle/timing events, not the transcript.

Add Grok to `src/capture/cwd-filter.ts`. The primary filter should decode the
cwd-bearing path segment under `.grok/sessions/<encoded-cwd>/...` and compare it
to `QUORUM_AGENT_CWD` after realpath normalization. If Grok records cwd in a
stable adjacent metadata file, that can be a fallback, but v1 should not require
it.

The capture path should read adjacent `summary.json` only for safe metadata
fallbacks such as session id, agent name, and model id. It should not treat
`summary.json`, `updates.jsonl`, `signals.json`, or `events.jsonl` as a token
usage source.

cwd filtering must be strict enough for multiple Grok sessions in the same
isolated home. Tests should cover `/tmp` versus `/private/tmp`, symlinks,
spaces and percent-encoded path segments, malformed encodings, prefix
collisions such as `/repo` versus `/repo-old`, multiple sessions under one cwd,
and wrong-cwd diagnostics.

## Normalizer

Add `src/normalize/grok.ts`, registered as `normalizer: grok`.

Mapping:

- `system` and `user` rows may emit content steps for full-fidelity trajectory
  when useful.
- `reasoning.summary` maps to `step.reasoning_content`.
- Encrypted reasoning content is not normalized into readable content; preserve
  only safe presence metadata if needed.
- `assistant.content` maps to `step.message`.
- `assistant.tool_calls[]` maps to `step.tool_calls[]`.
- `tool_result.tool_call_id` joins back as
  `step.observation.results[].source_call_id`.
- `assistant.model_id` maps to `step.model_name` on usage-bearing or
  assistant/tool steps.

Initial canonical tool map:

```text
run_terminal_command -> Bash
Shell                -> Bash
read_file            -> Read
write                -> Write
Write                -> Write
search_replace       -> Edit
list_dir             -> Glob
```

Grok has emitted both lower-case Grok Build-shaped tool names and
composer-shaped tool names in Phase 0 captures. The normalizer should treat
those as observed log dialects under the same `grok` target, not as separate
launcher modes.

Tool-call arguments may be stringified JSON. The normalizer must parse those
strings into ATIF `Record<string, unknown>` arguments. For `Read`, canonicalize
the common path aliases `target_file`, `filePath`, and `path` to `file_path`
while preserving the raw argument object in `extra.raw_arguments`. This keeps
existing `skill-called` transcript checks working for `SKILL.md` reads.

Unknown tools should remain as their native names, with parsed raw arguments
preserved in `extra`, so log drift is visible instead of silently erased.

Skill detection should use the existing transcript-check path. In the observed
logs, a Superpowers skill load appears as a `read_file` of a `SKILL.md`, which
normalizes to `Read` and can satisfy `skill-called`. If Grok later emits a
native skill invocation row, add a `Skill` mapping then.

Captured `chat_history.jsonl` rows do not carry timestamps. The normalizer must
preserve row order within each file and must not fabricate timestamps.

`tool_result` rows may appear after the assistant row that created the tool
call. ATIF validation requires an observation result's `source_call_id` to
reference a tool call on the same step. The Grok normalizer should keep a
`tool_call_id -> owning step` map and attach later results back to that owning
step. For assistant rows with multiple tool calls, keep all calls and their
later results on one owning step unless implementation evidence shows a cleaner
split that still validates.

`chat_history.jsonl` does not carry timestamps, request ids, cwd, duration, or
complete session metadata. Use adjacent `summary.json` or the session directory
name for `trajectory.session_id` and model fallback. Do not invent duration
metadata unless a later verified source gives a stable non-token duration.

## Usage And Pricing

Grok pricing must follow Quorum's ATIF economics contract:

- No hand-maintained Grok price math in evals.
- For v1, the verified Grok CLI source is native token buckets from a private
  debug-log extractor. Those buckets map into ATIF and obol prices them.
- Future native exact Grok/xAI cost should win over obol pricing only after it
  is verified in a safe, non-secret-bearing CLI artifact.
- Until obol knows Grok Build model IDs, usage remains token-present and
  cost-null/unpriced.

Phase 0 verification on `grok 0.2.56` found:

- `grok -p ... --output-format json` for both the default model and
  `-m grok-build` returns only `text`, `stopReason`, `sessionId`,
  `requestId`, and `thought`; it does not include usage or cost.
- `chat_history.jsonl` contains transcript rows but no usage/cost fields.
- `updates.jsonl` and `signals.json` contain context counters, not billable
  disjoint usage buckets.
- `--debug-file` for `-m grok-build` includes `model_id`, `request_id`,
  `input_tokens`, `output_tokens`, and `cache_read_tokens`.
- The same debug log contains auth-looking material and must be treated as
  secret-bearing.
- No `cache_write_tokens`, `cost_usd`, or `cost_in_usd_ticks` appeared in the
  live Grok Build debug run.
- Current `@primeradianthq/obol` does not price `grok-build`,
  `grok-build-0.1`, `xai/grok-build`, `x-ai/grok-build`,
  `xai/grok-build-0.1`, or `x-ai/grok-build-0.1`. A control fixture for
  `xai/grok-2` did price, so the missing rate is specific to Grok Build.

Therefore v1 needs a Grok-specific private debug usage extractor. The extractor
should:

- write Grok debug logs to a private temp path outside the run artifact tree;
- parse only allowlisted fields:
  `request_id`, `model_id`, `input_tokens`, `output_tokens`,
  `cache_read_tokens`;
- accept snake_case and camelCase variants of those fields if Grok emits both;
- represent each accepted span as:

  ```ts
  interface GrokUsageSpan {
    request_id: string;
    model_id: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
  }
  ```

- require nonempty `request_id` and `model_id`;
- require nonnegative integer token buckets;
- require `input_tokens >= cache_read_tokens`;
- dedupe repeated debug spans by request id, where exact duplicates are okay
  and conflicting duplicates fail closed;
- map to ATIF disjoint buckets as:
  `prompt_tokens = input_tokens - cache_read_tokens`,
  `cached_tokens = cache_read_tokens`,
  `completion_tokens = output_tokens`;
- fail closed rather than ignore new nonzero billing-relevant fields such as
  `reasoning_tokens`, image token buckets, server-side tool costs,
  `cache_write_tokens`, `service_tier`, or `cost_in_usd_ticks`;
- never archive the raw debug log;
- delete the raw debug log in cleanup;
- fail closed if cleanup cannot remove the raw debug log or if the raw log path
  would land under the run directory.

The debug extractor is an input to ATIF usage. It is not a second transcript
normalizer and it is not a cost calculator.

Because `chat_history.jsonl` does not expose request ids, v1 should aggregate
debug usage into trajectory-level final metrics rather than pretending to join
usage spans to individual assistant steps:

- `final_metrics.total_prompt_tokens = sum(input_tokens - cache_read_tokens)`
- `final_metrics.total_completion_tokens = sum(output_tokens)`
- `final_metrics.extra.total_cached_tokens = sum(cache_read_tokens)`
- `final_metrics.extra.grok_usage_source = "debug-file"`
- `agent.model_name` should be set when all accepted spans agree on a model id;
  otherwise keep per-span model ids in `extra.grok_usage_models`

This merge must happen before `trajectory.json` is written and before
`captureTokenUsage` runs, so existing `estimateTrajectory(..., "atif")` remains
the single pricing path. Do not add a separate raw-debug-log pricing path.

The exact baseline launcher must prove this path before v1 acceptance. Phase 0
proved debug usage for `-m grok-build`; because the v1 baseline remains normal
`grok`, implementation must live-smoke that `grok --debug-file ...` without
`-m` emits the same required token fields under API-key auth.

An obol update should add Grok Build pricing/model aliases centrally. xAI's
public docs list `grok-build-0.1` at `$1.00/1M` input, `$0.20/1M` cached input,
and `$2.00/1M` output, with higher-context pricing above 200k context. That
pricing belongs in obol, not in Quorum. Until obol support lands,
`coding-agent-token-usage.json` may contain Grok tokens with null cost and an
explicit unpriced model.

## Implementation Phases

### Phase 1: Target registration, provisioning, and launcher

Add:

- `coding-agents/grok.yaml`
- `coding-agents/grok-context/HOWTO.md`
- `coding-agents/grok-context/launch-agent`
- `src/agents/grok.ts`

Provisioning should:

- require `SUPERPOWERS_ROOT`;
- require `XAI_API_KEY`;
- resolve `grok` on `PATH`;
- seed isolated `.grok/config.toml` with `[plugins].paths`;
- run `grok inspect --json` and verify required Superpowers skills;
- ensure host OAuth auth is not copied into the isolated home;
- build private temp paths for the runtime env file and debug log outside the
  run artifact tree;
- write a mode-0600 runtime env file containing `XAI_API_KEY`;
- return launch substitutions for `$GROK_ENV_FILE` and `$GROK_DEBUG_FILE`;
- register cleanup for private runtime files and fail if cleanup cannot remove
  the raw debug log.

### Phase 2: Transcript normalizer and capture

Add:

- `src/normalize/grok.ts`
- `test/normalize.grok.test.ts`
- Grok registration in `src/capture/index.ts`
- Grok cwd filtering in `src/capture/cwd-filter.ts`
- bootstrap/check-tool coverage for a `grok` target where needed

Tests should use small fixtures sliced from real Phase 0 `chat_history.jsonl`
logs, not invented golden snapshots.

### Phase 3: Usage extraction and economics

Implement the private debug-log usage extractor, sanitized `GrokUsageSpan`
schema, final-metrics ATIF merge, and cleanup guards. Parser unit tests can use
sanitized fixtures, but the acceptance gate is a live API-key-only run of the
exact baseline launcher, including `--debug-file` and no `-m`.

In parallel or immediately after, update obol to price Grok Build model IDs and
aliases. If obol cannot land in the same stack, Quorum should keep Grok
token-present/cost-null and document the obol dependency explicitly.

### Phase 4: Live smoke and documentation

Run the live maintainer smoke, record the outcome in `docs/experiments/`, and
update Grok HOWTO/docs with the accepted auth, plugin, capture, and unpriced
economics behavior.

## Test Plan

Unit tests:

- `normalize.grok` covers assistant text, reasoning summaries, tool calls,
  delayed tool results on the owning step, stringified argument parsing,
  `target_file`/`filePath`/`path` canonicalization, skill-file reads, unknown
  tools, model attribution, invalid JSONL fail-closed behavior, and no
  fabricated timestamps.
- Grok cwd-filter tests cover encoded cwd matching, realpath normalization,
  `/tmp` versus `/private/tmp`, symlinks, spaces and percent encodings,
  malformed path rejection, prefix collisions, multiple sessions under the
  same cwd, mismatch filtering, and wrong-cwd diagnostics.
- Grok provisioner tests cover missing `grok`, missing `SUPERPOWERS_ROOT`,
  missing `XAI_API_KEY`, absent required skills, and successful isolated config
  seeding.
- Grok launcher/context tests cover required `grok-context`, unresolved
  `$GROK_ENV_FILE` / `$GROK_DEBUG_FILE` placeholders, mode-0600 env file
  creation, artifact-external debug path allocation, and no host auth copy.
- Grok usage extractor tests cover allowlisted parsing, snake_case/camelCase
  fields, repeated request-id dedupe, conflicting duplicate rejection,
  disjoint token math, absent cache-write, absent cost, unknown billable-field
  fail-closed behavior, raw-log cleanup, and rejection when the debug path is
  under the run directory.
- obol fixture tests prove the Grok Build ATIF model IDs price once obol support
  lands; until then, a guard fixture should assert token-present/unpriced
  behavior is explicit.

Routine gates:

```bash
bun run check
bun run quorum check
```

Live maintainer smoke:

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
export XAI_API_KEY=...
bun run quorum run scenarios/00-quorum-smoke-hello-world \
  --coding-agent grok \
  --out-root /tmp/quorum-grok-smoke
```

The first successful smoke must verify:

- final verdict is `pass`;
- `trajectory.json` exists and has nonempty Grok tool calls;
- `coding-agent-token-usage.json` has nonzero Grok coding-agent tokens;
- Grok model keys are visible and either priced by obol or explicitly listed as
  unpriced;
- no raw Grok debug log exists under the run artifact tree;
- the full `XAI_API_KEY` value appears nowhere in the run artifact tree;
- structural auth/debug markers such as `Authorization`, `Bearer`,
  `access_token`, `refresh_token`, `auth.json`, and raw debug-log-only markers
  do not appear in run artifacts except in expected redacted diagnostics;
- `grok inspect --json` in the isolated home sees the required Superpowers
  skills.

Additional live captures before declaring the normalizer stable:

- an API-key-only run of the intended launcher;
- a multi-tool run with multiple tool results;
- an unknown-tool or errored-tool run;
- a Grok subagent/persona run only if Quorum transcript checks need to assert
  subagent behavior for Grok.

## Risks And Follow-ups

- **API-key auth not yet verified locally:** Phase 0 host had browser auth but
  no `XAI_API_KEY` in the shell. Treat API-key-only smoke as a hard v1
  acceptance gate.
- **Debug-log format drift:** The usage extractor depends on Grok debug spans.
  Keep fixtures small and strict, fail closed on missing required fields or new
  nonzero billing fields, and preserve token-present/cost-null behavior rather
  than guessing.
- **Debug logs are secret-bearing:** This is the main security risk. Raw debug
  logs must never be archived, committed, or included in verdict diagnostics.
- **Path plugin scope:** `[plugins].paths` currently proves skill discovery,
  not hooks or trust. Keep v1 checks scoped to skill-file behavior until a real
  Grok Superpowers manifest is available.
- **Obol support required for dollars:** Quorum can carry Grok token usage
  before obol prices it, but dollar comparisons are incomplete until obol knows
  Grok Build rates and aliases.
- **Windows support deferred:** Add Windows only after Quorum has a Grok
  Windows provisioner/launcher and a real Windows smoke runner.
- **Superpowers Grok manifest:** SUP-384 should make Grok support a first-class
  Superpowers repo contract. Quorum v1 should not block on it, but should switch
  once it is available and verified.

## References

- xAI Grok Build CLI announcement:
  `https://x.ai/news/grok-build-cli`
- xAI Build overview:
  `https://docs.x.ai/build/overview`
- xAI Grok Build 0.1 model and pricing:
  `https://docs.x.ai/developers/models/grok-build-0.1`
- xAI pricing table:
  `https://docs.x.ai/developers/pricing`
- xAI cost tracking:
  `https://docs.x.ai/developers/cost-tracking`
- xAI prompt caching usage fields:
  `https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing`
- Superpowers Grok manifest follow-up:
  `https://linear.app/prime-radiant/issue/SUP-384/add-first-class-grok-build-plugin-manifest-for-superpowers`
