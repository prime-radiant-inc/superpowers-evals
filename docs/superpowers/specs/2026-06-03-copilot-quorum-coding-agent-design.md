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
for name in COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN; do
  if [[ -n "${!name-}" ]]; then
    env_args+=("$name=${!name}")
  fi
done

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
    --log-dir "$COPILOT_HOME/logs" \
    "$@"
```

The implementation may preserve selected proxy, certificate, and model-provider
environment variables using the same `env -i` allowlist style as OpenCode. It
should include only variables needed for Copilot to start and for shell commands
inside the eval to behave normally.

`$COPILOT_ENV_FILE` is a chmod-0600 per-run shell fragment written by the
runner. It should contain the selected authentication token variable when the
host has `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`.
If no usable auth source exists, runner setup should fail before the scenario is
started.

`$QUORUM_COPILOT_SESSION_ID` should be a run-specific UUID generated by the
runner and substituted into the launcher and HOWTO. The purpose is not
cross-run reproducibility; it is to make the expected session-state path
unambiguous within a run.

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
    "view": "Read",
    "rg": "Grep",
    "glob": "Glob",
    "task": "Agent",
    "update_todo": "TodoWrite",
    "web_fetch": "WebFetch",
    "web_search": "WebSearch",
}
```

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

## Runner data flow

1. `quorum run scenarios/foo --coding-agent copilot` loads
   `coding-agents/copilot.yaml`.
2. Runner allocates `<run>/coding-agent-config` and calls
   `_seed_copilot_config`.
3. `_seed_copilot_config` verifies `copilot` exists on `PATH`, verifies
   `SUPERPOWERS_ROOT`, resolves authentication, writes `$COPILOT_ENV_FILE`,
   creates isolated directories, stages the Superpowers plugin, and verifies
   staged paths remain under `$COPILOT_HOME`.
4. Scenario `setup.sh` and pre-checks run normally.
5. Runner resolves the launch cwd.
6. Runner generates `$QUORUM_COPILOT_SESSION_ID` and populates
   `copilot-context` with literal paths for `$QUORUM_LAUNCH_AGENT`,
   `$QUORUM_AGENT_CWD`, `$COPILOT_HOME`, `$COPILOT_ENV_FILE`, and
   `$QUORUM_COPILOT_SESSION_ID`.
7. Runner snapshots `${COPILOT_HOME}/session-state/**/events.jsonl`.
8. Gauntlet drives the QA agent, which launches Copilot through the generated
   launcher.
9. Copilot loads the staged plugin, runs `hooks/session-start`, receives
   top-level `additionalContext`, and writes session-state events under
   `$COPILOT_HOME`.
10. Quorum captures new `events.jsonl` files and normalizes tool calls with the
    Copilot normalizer.
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
- a session-state `events.jsonl` exists before the capture snapshot.

After a run, Copilot should get the same strict capture diagnostics as Gemini,
OpenCode, and Antigravity:

- no new session-state log under isolated `COPILOT_HOME` means indeterminate,
  not a normal fail;
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
testing startup bootstrap behavior, not completion of the todo app.

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
- It should verify generated context substitutes `$COPILOT_HOME`,
  `$COPILOT_ENV_FILE`, `$QUORUM_COPILOT_SESSION_ID`, and
  `$QUORUM_LAUNCH_AGENT`.
- It should verify Copilot is added to strict capture names.

Normalizer:

- `tests/quorum/test_normalizers.py` should include a sanitized Copilot
  session-state fixture with `skill`, `bash`, `apply_patch`, `view`, `rg`,
  `glob`, `task`, `update_todo`, `web_fetch`, and `web_search` tool requests.
- It should assert `skill` rows include both
  `.skill == "superpowers:brainstorming"` and `.name == "brainstorming"`.
- It should assert `apply_patch` paths are extracted like OpenCode where the
  patch text is available.

Capture:

- `tests/quorum/test_capture.py` should verify
  `capture_tool_calls(... normalizer="copilot")` reads new
  `session-state/**/events.jsonl` files and writes canonical rows.

Trace tool:

- `tests/quorum/test_trace_tools.py` should cover
  `copilot-plugin-installed` success and failure cases.

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
- `copilot-plugin-installed` passes;
- Copilot logs show no plugin or hook loading error.

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
- The Copilot normalizer emits canonical rows consumed by existing trace tools.
- The bootstrap scenario passes only when Copilot invokes
  `superpowers:brainstorming` before implementation tools.
- Static tests cover config loading, runner seeding, normalizer behavior,
  trace-tool behavior, capture behavior, and scenario validation.
