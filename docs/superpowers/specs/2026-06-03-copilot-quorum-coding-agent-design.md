# Copilot Quorum Coding-Agent Target - design specification

**Linear:** PRI-2055
**Status:** Specification. Ready for Drew review. Not yet implemented.
**Date:** 2026-06-03
**Context:** Superpowers supports GitHub Copilot CLI through the existing
Claude-style plugin directory and `hooks/session-start` emits Copilot's
top-level `additionalContext` shape when `COPILOT_CLI=1`. Quorum does not yet
have a first-class `--coding-agent copilot` target.

---

## Goal

Add `copilot` as a first-class Quorum Coding-Agent target so the same
behavioral scenarios used for Claude, Codex, Gemini, Antigravity, OpenCode, and
Pi can exercise Superpowers inside GitHub Copilot CLI.

The target must conform to the existing Quorum harness model:

- one `coding-agents/copilot.yaml` config;
- one generated launcher under `coding-agents/copilot-context/`;
- one runner provisioning hook that prepares an isolated per-run config home;
- one normalizer that writes canonical `coding-agent-tool-calls.jsonl` rows;
- one bootstrap smoke scenario proving the Superpowers workflow is active.

Expected maintainer command shape:

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
uv run quorum run scenarios/copilot-superpowers-bootstrap --coding-agent copilot
```

The runner should accept Copilot authentication from `COPILOT_GITHUB_TOKEN`,
`GH_TOKEN`, `GITHUB_TOKEN`, or a usable `gh auth token` fallback. If the runner
must materialize a token into the per-run home, the run directory is a
secret-bearing live-eval artifact.

## Non-goals

- Public CI live Copilot runs. Like other live Quorum evals, Copilot runs are
  trusted-maintainer operations.
- Reusing or mutating the user's global `~/.copilot` state.
- Installing from the Copilot marketplace in v1. Quorum should test the local
  Superpowers checkout that is under development.
- A generic staged-plugin abstraction shared by all Coding-Agents.
- Token/cost accounting beyond whatever can be safely extracted from Copilot
  session-state events after core trace capture works.
- OTel-driven trace checks. OTel may be preserved as supplemental telemetry, but
  it is not the primary source for Quorum pass/fail behavior.

## Current harness model

Quorum already has the extension points Copilot needs:

- `coding-agents/<name>.yaml` declares the binary, per-run config env var,
  session-log directory, log glob, normalizer, required env, timeout, and
  concurrency.
- `<name>-context/launch-agent` bakes cwd, config home, permission flags, and
  install path into one executable command for the Gauntlet-Agent to run.
- `<name>-context/HOWTO.md` tells the Gauntlet-Agent to launch the target with
  the generated launcher rather than reconstructing the command.
- `quorum/runner.py` creates `<run>/coding-agent-config` before scenario setup
  and calls target-specific provisioning hooks for harnesses that need local
  setup.
- `quorum/capture.py` snapshots, diffs, normalizes, and writes
  `coding-agent-tool-calls.jsonl`.
- Strict-capture targets fail indeterminate if no transcript appears or if a
  transcript normalizes to zero tool-call rows.

Copilot should fit this model directly. It should be closer to OpenCode and
Antigravity than Claude because the run should contain a staged copy of the
plugin that Copilot loaded.

## Copilot runtime setup

Add `coding-agents/copilot.yaml`:

```yaml
name: copilot
binary: copilot
agent_config_env: COPILOT_HOME
session_log_dir: "${COPILOT_HOME}/session-state"
session_log_glob: "**/events.jsonl"
normalizer: copilot
required_env:
  - SUPERPOWERS_ROOT
max_time: 10m
max_concurrency: 1
```

`COPILOT_HOME` resolves to `<run>/coding-agent-config`. The runner must not read
from or write to the user's real `~/.copilot`.

Runner provisioning should create at least:

```text
$COPILOT_HOME/
  .quorum/
  .cache/
  logs/
  plugins/superpowers/
  session-state/
```

The generated launcher should run in effect:

```bash
cd "$QUORUM_AGENT_CWD"
set -a
. "$COPILOT_ENV_FILE"
set +a

env_args=(
  "PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  "TERM=${TERM:-xterm-256color}"
  "LANG=${LANG:-C.UTF-8}"
)
for name in \
  COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN \
  GH_HOST COPILOT_GH_HOST \
  HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY \
  http_proxy https_proxy all_proxy no_proxy \
  SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE CURL_CA_BUNDLE \
  COPILOT_MODEL COPILOT_OFFLINE \
  COPILOT_PROVIDER_BASE_URL COPILOT_PROVIDER_TYPE \
  COPILOT_PROVIDER_API_KEY COPILOT_PROVIDER_BEARER_TOKEN \
  COPILOT_PROVIDER_WIRE_API COPILOT_PROVIDER_AZURE_API_VERSION \
  COPILOT_PROVIDER_MODEL_ID COPILOT_PROVIDER_WIRE_MODEL \
  COPILOT_PROVIDER_MAX_PROMPT_TOKENS COPILOT_PROVIDER_MAX_OUTPUT_TOKENS; do
  if [[ -n "${!name-}" ]]; then
    env_args+=("$name=${!name}")
  fi
done

secret_env_vars=(
  COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN
  COPILOT_PROVIDER_API_KEY COPILOT_PROVIDER_BEARER_TOKEN
)

exec env -i \
  "${env_args[@]}" \
  HOME="$COPILOT_HOME" \
  COPILOT_HOME="$COPILOT_HOME" \
  COPILOT_CACHE_HOME="$COPILOT_HOME/.cache" \
  COPILOT_CLI=1 \
  COPILOT_AUTO_UPDATE=false \
  copilot \
    --plugin-dir "$COPILOT_HOME/plugins/superpowers" \
    --session-id "$QUORUM_COPILOT_SESSION_ID" \
    --allow-all \
    --no-auto-update \
    --no-remote \
    --disable-builtin-mcps \
    --secret-env-vars="$(IFS=,; echo "${secret_env_vars[*]}")" \
    --log-dir "$COPILOT_HOME/logs" \
    "$@"
```

The launcher should keep this allowlist concrete. It preserves GitHub host
selection, proxy and certificate variables, and Copilot BYOK variables because
those are legitimate ways a maintainer's Copilot CLI may reach the service. It
should not inherit arbitrary host environment variables.

`--secret-env-vars` must include every preserved token or provider secret. Those
variables are still available to the Copilot process, but Copilot strips them
from shell and MCP tool environments and redacts their values from output. If a
future implementation preserves another secret-bearing variable such as
`OTEL_EXPORTER_OTLP_HEADERS`, it must add that variable to the secret list at
the same time.

`COPILOT_CACHE_HOME` is a best-effort isolation variable for caches. It should
point inside `$COPILOT_HOME`, but the implementation must not rely on it as the
primary correctness boundary. `COPILOT_HOME`, `--plugin-dir`, `--log-dir`, and
session-state capture are the hard isolation contracts.

`$COPILOT_ENV_FILE` is a chmod-0600 per-run shell fragment written by the
runner. It should contain the selected authentication token variable when the
host has `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`.
If no usable auth source exists, runner setup should fail before the scenario is
started. Token values must not appear in the generated HOWTO, launcher text,
runner error messages, verdict JSON, or check records.

`$QUORUM_COPILOT_SESSION_ID` should be a run-specific UUID generated by the
runner before Copilot provisioning and substituted into the launcher and HOWTO.
The purpose is not cross-run reproducibility; it is to make the expected
session-state path unambiguous within a run and to let setup reject stale
session-state before capture begins.

## Superpowers staging

Runner provisioning should stage the local Superpowers checkout into:

```text
$COPILOT_HOME/plugins/superpowers/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/run-hook.cmd
  hooks/session-start
  skills/
```

The staged directory is the only plugin directory passed to Copilot. This makes
the run artifact self-contained and makes it possible to inspect exactly what
Copilot loaded after a failed run.

Required source files under `SUPERPOWERS_ROOT`:

- `.claude-plugin/plugin.json`
- `hooks/hooks.json`
- `hooks/run-hook.cmd`
- `hooks/session-start`
- `skills/using-superpowers/SKILL.md`
- `skills/brainstorming/SKILL.md`
- `skills/using-superpowers/references/copilot-tools.md`

The runner should copy the full `skills/` tree rather than a minimal subset.
That matches OpenCode's approach and avoids false confidence from a bootstrap
that can load `using-superpowers` but cannot load the skill it asks for next.

The runner should reject symlinks inside `SUPERPOWERS_ROOT/skills`, as OpenCode
does, and should verify that every staged plugin path resolves under
`$COPILOT_HOME`. This avoids accidentally making a supposedly isolated run
depend on mutable files outside the run artifact.

## Copilot plugin contract validation

The staged layout intentionally reuses the existing Claude-style Superpowers
plugin files, but the implementation must verify Copilot's actual plugin
contract rather than assuming Claude semantics transfer unchanged.

Before the live bootstrap scenario is considered valid, implementation should
prove all of the following with isolated `COPILOT_HOME` artifacts:

- `--plugin-dir "$COPILOT_HOME/plugins/superpowers"` points Copilot at the
  staged plugin root itself, not at a parent directory.
- Copilot recognizes the staged `.claude-plugin/plugin.json` as the plugin
  manifest for this shape.
- Copilot recognizes `hooks/hooks.json` from the staged plugin.
- Copilot expands the plugin-root variable used by that hook config, or the
  implementation updates the staged hook config to the Copilot-specific
  variable Copilot actually provides.
- The staged SessionStart matcher fires for a new interactive CLI session.
- `hooks/session-start` runs with `COPILOT_CLI=1` and emits top-level
  `additionalContext`.
- Copilot consumes that `additionalContext` before the user's first prompt.
- Copilot discovers the staged `skills/` tree and exposes native `skill` tool
  calls with enough arguments for Quorum to normalize
  `superpowers:brainstorming`.

Runner setup should use a non-model, non-mutating validation command when
Copilot exposes one. For example, if
`copilot --plugin-dir "$COPILOT_HOME/plugins/superpowers" plugin list` reports
the staged Superpowers plugin and paths under `$COPILOT_HOME`, setup should fail
if that proof is absent. This command is install evidence only; hook execution
and bootstrap ingestion still require the live bootstrap scenario.

No new Superpowers hook script is needed for v1. Existing
`hooks/session-start` already emits:

```json
{ "additionalContext": "..." }
```

when `COPILOT_CLI=1` is present. That is the Copilot/SDK-standard shape.

## Capture and normalization

Copilot's primary trace source should be:

```text
$COPILOT_HOME/session-state/$QUORUM_COPILOT_SESSION_ID/events.jsonl
```

The Quorum config uses the broader glob `**/events.jsonl` so the normal capture
machinery still works if Copilot writes nested or renamed session-state
directories, but the generated session id gives the runner and humans a clear
expected path.

Observed Copilot session-state events include:

```json
{"type":"assistant.message","data":{"toolRequests":[{"toolCallId":"...","name":"bash","arguments":{"command":"ls"}}]}}
{"type":"tool.execution_complete","data":{"toolCallId":"...","toolName":"bash","success":true}}
{"type":"session.shutdown","data":{"tokenDetails":{"input":{"tokenCount":36}},"codeChanges":{"filesModified":[]}}}
```

`normalize_copilot_logs()` should normalize tool requests from
`assistant.message` events. Tool execution events can be reserved for result
metadata in a future change, but the trace tools only need ordered tool-request
rows.

Initial tool map:

```python
COPILOT_TOOL_MAP = {
    "skill": "Skill",
    "bash": "Bash",
    "apply_patch": "Edit",
    "edit": "Edit",
    "create": "Write",
    "write": "Write",
    "view": "Read",
    "rg": "Grep",
    "glob": "Glob",
    "task": "Agent",
    "read_agent": "Agent",
    "list_agents": "Agent",
    "write_agent": "Agent",
    "update_todo": "TodoWrite",
    "web_fetch": "WebFetch",
    "web_search": "WebSearch",
}
```

This map should be pinned from real sanitized Copilot session-state fixtures
before implementation is considered complete. If real Copilot uses additional
implementation tools, especially file-writing or file-editing tools, those
tools must be added to the map so `skill-before-tool` checks cannot miss early
implementation work.

Skill arguments should be canonicalized like OpenCode:

```json
{
  "tool": "Skill",
  "args": {
    "skill": "superpowers:brainstorming",
    "name": "brainstorming",
    "raw_input": {"skill": "superpowers:brainstorming"}
  },
  "source": "native"
}
```

Source classification should match existing normalizer conventions:

- `Bash` rows are `source: "shell"`.
- Copilot-native tools are `source: "native"`.
- Unknown tool names pass through unchanged with a conservative source value
  based on the canonical name.

OTel should remain optional. If the implementation writes
`COPILOT_OTEL_FILE_EXPORTER_PATH="$COPILOT_HOME/.quorum/copilot-otel.jsonl"`, it
should document that file as telemetry only. Quorum pass/fail trace checks
should not depend on OTel.

OTel should default off. If it is enabled for debugging, output must stay inside
the run directory and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`
should remain unset or false by default because message-content capture can
record prompts, tool inputs, tool outputs, and secrets.

## Runner data flow

1. `quorum run scenarios/foo --coding-agent copilot` loads
   `coding-agents/copilot.yaml`.
2. Runner allocates `<run>/coding-agent-config`, generates
   `$QUORUM_COPILOT_SESSION_ID`, and calls `_seed_copilot_config`.
3. `_seed_copilot_config` verifies `copilot` exists on `PATH`, verifies
   `SUPERPOWERS_ROOT`, resolves authentication, writes `$COPILOT_ENV_FILE`,
   creates isolated directories, stages the Superpowers plugin, and verifies
   staged paths remain under `$COPILOT_HOME`. It also verifies no stale
   `$COPILOT_HOME/session-state/$QUORUM_COPILOT_SESSION_ID/events.jsonl` exists.
4. Scenario `setup.sh` and pre-checks run normally.
5. Runner resolves the launch cwd.
6. Runner populates `copilot-context` with literal paths for
   `$QUORUM_LAUNCH_AGENT`, `$QUORUM_AGENT_CWD`, `$COPILOT_HOME`,
   `$COPILOT_ENV_FILE`, and `$QUORUM_COPILOT_SESSION_ID`.
7. Runner snapshots `${COPILOT_HOME}/session-state/**/events.jsonl`.
8. Gauntlet drives the QA agent, which launches Copilot through the generated
   launcher.
9. Copilot loads the staged plugin, runs `hooks/session-start`, receives
   top-level `additionalContext`, and writes session-state events under
   `$COPILOT_HOME`.
10. Quorum captures new `events.jsonl` files and normalizes tool calls with the
    Copilot normalizer. The expected primary session file,
    `$COPILOT_HOME/session-state/$QUORUM_COPILOT_SESSION_ID/events.jsonl`, must
    be among the captured logs. Extra session-state logs may be captured as
    supplemental context, but they cannot satisfy the primary-session
    requirement by themselves.
11. Strict-capture checks fail indeterminate if no Copilot session-state log
    appeared or if captured logs normalized to zero rows.
12. Post-checks compose verdicts through the normal Quorum path.

## Failure modes

Runner setup should fail clearly when:

- `SUPERPOWERS_ROOT` is missing.
- required Superpowers plugin, hook, or skill files are missing.
- `copilot` is not on `PATH`.
- no supported Copilot auth source exists.
- `gh auth token` is needed but `gh` is missing or returns no token.
- staged plugin files would escape `$COPILOT_HOME`.
- `SUPERPOWERS_ROOT/skills` contains symlinks.
- the expected session-state `events.jsonl` exists before the capture snapshot.

After a run, Copilot should get the same strict capture diagnostics as Gemini,
OpenCode, and Antigravity:

- no new session-state log under isolated `COPILOT_HOME` means indeterminate,
  not a normal fail;
- new session-state logs that do not include
  `$COPILOT_HOME/session-state/$QUORUM_COPILOT_SESSION_ID/events.jsonl` mean
  indeterminate, not a normal fail;
- one or more session-state logs that normalize to zero rows means
  indeterminate with the relative log paths in the reason.

If Copilot starts but does not run the staged session-start hook, the bootstrap
scenario should fail through post-checks because no `Skill` trace for
`superpowers:brainstorming` appears. This is a behavioral failure, not merely a
missing file failure.

## Trace tool and scenario additions

Add `bin/copilot-plugin-installed`.

When `QUORUM_RUN_DIR` is set, it should inspect:

```text
$QUORUM_RUN_DIR/coding-agent-config/plugins/superpowers/
```

It should require:

- `.claude-plugin/plugin.json`
- `hooks/hooks.json`
- `hooks/run-hook.cmd`
- `hooks/session-start`
- `skills/using-superpowers/SKILL.md`
- `skills/brainstorming/SKILL.md`

It should record pass/fail through the existing `_record` helper, matching
`opencode-plugin-installed` and `antigravity-plugin-installed`.

Add `scenarios/copilot-superpowers-bootstrap`:

```bash
# coding-agents: copilot

pre() {
    git-repo
    git-branch main
}

post() {
    copilot-plugin-installed
    tool-arg-match Skill '.skill == "superpowers:brainstorming"'
    skill-called superpowers:brainstorming
    skill-before-tool superpowers:brainstorming Edit
    skill-before-tool superpowers:brainstorming Write
}
```

The story should mirror OpenCode's bootstrap scenario: the QA agent starts
Copilot, sends exactly `Let's make a react todo list`, and stops once Copilot
loads a skill, starts brainstorming, or starts implementation. The scenario is
testing startup bootstrap behavior, not completion of the todo app. Acceptance
should be worded as: Copilot must invoke `superpowers:brainstorming`, and any
implementation tool call must happen after that skill invocation.

## Tests

Add focused tests before implementation.

Config loading:

- `tests/quorum/test_coding_agent_config.py` should verify
  `coding-agents/copilot.yaml` loads, resolves `${COPILOT_HOME}`, and rejects an
  unknown normalizer before the normalizer is registered.

Runner seeding:

- `tests/quorum/test_runner.py` should cover successful Copilot config seeding
  with staged plugin files under `coding-agent-config/plugins/superpowers`.
- It should cover missing `SUPERPOWERS_ROOT`, missing `copilot`, missing auth,
  and missing required plugin files.
- It should cover auth-source priority:
  `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`, then
  `gh auth token`.
- It should assert `$COPILOT_ENV_FILE` is chmod 0600, shell-quotes token values
  safely, and never leaks token values into generated HOWTO text, launcher text,
  setup errors, verdict JSON, or check records.
- It should verify generated context substitutes `$COPILOT_HOME`,
  `$COPILOT_ENV_FILE`, `$QUORUM_COPILOT_SESSION_ID`, and
  `$QUORUM_LAUNCH_AGENT`.
- It should run the generated launcher against a fake `copilot` executable with
  shell-sensitive paths and assert `HOME`, `COPILOT_HOME`, `COPILOT_CLI=1`,
  `--plugin-dir`, `--session-id`, `--secret-env-vars`, env-file sourcing, and
  trailing `"$@"` forwarding all behave correctly under `env -i`.
- It should cover staged plugin validation when a fake `copilot plugin list`
  reports the plugin and when it does not.
- It should verify Copilot is added to strict capture names.
- It should include runner-level missing-transcript, missing expected
  session-state path, and zero-row strict-capture tests, mirroring the existing
  Gemini, OpenCode, and Antigravity diagnostics.
- It should cover setup rejecting a stale
  `session-state/$QUORUM_COPILOT_SESSION_ID/events.jsonl`.

Normalizer:

- `tests/quorum/test_normalizers.py` should include a sanitized Copilot
  session-state fixture with `skill`, `bash`, `apply_patch`, `view`, `rg`,
  `glob`, `task`, `read_agent`, `list_agents`, `write_agent`, `update_todo`,
  `web_fetch`, and `web_search` tool requests. If real fixtures show `edit`,
  `create`, or `write`, those should be covered too.
- It should assert `skill` rows include both
  `.skill == "superpowers:brainstorming"` and `.name == "brainstorming"`.
- It should assert `apply_patch` paths are extracted like OpenCode where the
  patch text is available.
- It should cover multiple `toolRequests` in one `assistant.message`, malformed
  JSONL lines, non-dict JSON lines, `tool.execution_complete` events, and
  `session.shutdown` events.
- It should include a negative fixture where an implementation tool appears
  before `superpowers:brainstorming`, proving the scenario checks fail for that
  trace.

Capture:

- `tests/quorum/test_capture.py` should verify
  `capture_tool_calls(... normalizer="copilot")` reads new
  `session-state/**/events.jsonl` files and writes canonical rows.

Trace tool:

- `tests/quorum/test_trace_tools.py` should cover
  `copilot-plugin-installed` success and failure cases, including failure when
  `skills/using-superpowers/references/copilot-tools.md` is absent.

Scenario validation:

- `tests/quorum/test_scaffold.py` should verify
  `copilot-superpowers-bootstrap` requires native `Skill` evidence and
  implementation ordering checks, mirroring the OpenCode scenario test.

Static verification:

```bash
uv run ruff check
uv run ty check
uv run quorum check
uv run pytest
```

Live smoke:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers \
  uv run quorum run scenarios/copilot-superpowers-bootstrap --coding-agent copilot
uv run quorum show
```

Success artifacts:

- `verdict.json` final verdict is `pass`;
- `coding-agent-tool-calls.jsonl` contains a canonical `Skill` row for
  `superpowers:brainstorming`;
- `coding-agent-config/plugins/superpowers/` contains the staged plugin;
- `coding-agent-config/session-state/<session-id>/events.jsonl` exists;
- the captured session-state path matches `$QUORUM_COPILOT_SESSION_ID`;
- `copilot-plugin-installed` passes;
- Copilot logs show no plugin or hook loading error;
- Copilot logs or session-state evidence show the staged SessionStart hook ran
  and the bootstrap reached the first model turn.

## Documentation

Update the Quorum README coding-agent table or surrounding docs to mention:

- `--coding-agent copilot`;
- required local `SUPERPOWERS_ROOT`;
- supported auth sources;
- isolated `COPILOT_HOME` behavior;
- session-state capture as the primary trace source;
- live Copilot runs are trusted-maintainer operations, not public CI.

## Acceptance criteria

- `uv run quorum run scenarios/copilot-superpowers-bootstrap --coding-agent copilot`
  treats Copilot as a known target.
- The run uses an isolated `COPILOT_HOME` under the Quorum run directory.
- Copilot loads Superpowers from the staged plugin under
  `$COPILOT_HOME/plugins/superpowers`.
- The staged plugin's session-start hook injects the existing
  `using-superpowers` bootstrap through top-level `additionalContext`.
- Quorum captures Copilot session-state events from the isolated home.
- The captured primary session-state file is
  `$COPILOT_HOME/session-state/$QUORUM_COPILOT_SESSION_ID/events.jsonl`.
- The Copilot normalizer emits canonical rows consumed by existing trace tools.
- The bootstrap scenario passes only when Copilot invokes
  `superpowers:brainstorming`, and any implementation tool call occurs after
  that skill invocation.
- Static tests cover config loading, runner seeding, normalizer behavior,
  trace-tool behavior, capture behavior, strict-capture behavior, auth
  containment, launcher execution, and scenario validation.
