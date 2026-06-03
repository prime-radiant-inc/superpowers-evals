# Pi Quorum Coding-Agent Target - design specification

**Linear:** PRI-2047
**Status:** Implemented and live-verified.
**Date:** 2026-06-03
**Context:** Superpowers supports Pi through the parent repo's Pi package
manifest and `.pi/extensions/superpowers.ts`. Quorum already has a `pi`
normalizer and Pi cwd filtering, but Pi is not yet available as a first-class
`--coding-agent pi` target before this work.

---

## Goal

Add `pi` as a first-class Quorum Coding-Agent target so the same behavioral
scenarios used for Claude, Codex, and Antigravity can exercise Superpowers
inside Pi.

The harness should be reproducible and should not depend on Drew's personal
`~/.pi/agent` state. Each run gets an isolated Pi config directory under the
Quorum run directory, authenticated from a run-local API-key environment file,
and pointed at the local `SUPERPOWERS_ROOT` checkout.

Expected maintainer command shape:

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
export PI_PROVIDER=azure-openai-responses
export PI_MODEL=gpt-5.4
export PI_API_KEY=...
# For azure-openai-responses only, also provide one of:
export AZURE_OPENAI_BASE_URL=https://your-resource.openai.azure.com
# or: export AZURE_OPENAI_RESOURCE_NAME=your-resource
uv run quorum run scenarios/<scenario> --coding-agent pi
```

`PI_PROVIDER` and `PI_MODEL` select the Pi model explicitly. `PI_API_KEY` is a
generic Quorum-side secret that the runner exposes only to the isolated Pi
process, not a Pi-native provider-specific env var. Provider-specific
non-key configuration still belongs to the provider's native environment. For
example, `azure-openai-responses` needs `AZURE_OPENAI_BASE_URL` or
`AZURE_OPENAI_RESOURCE_NAME`; the runner should copy those values into the
run-local env file so tmux environment stripping cannot drop them.

## Verified live facts

Local discovery on 2026-06-03 found:

- `pi` is installed and reports version `0.78.0`.
- `pi --session-dir <dir> --print ...` writes a flat `*.jsonl` session file
  directly under `<dir>`.
- The first JSONL row is `{"type":"session", ... "cwd": "<launch cwd>"}`,
  which matches Quorum's existing `filter_pi_logs_by_cwd` assumptions.
- A forced `read` tool call logs as an assistant `toolCall` content block with
  lowercase name `read`, and the existing `normalize_pi_logs()` maps it to
  Quorum's canonical `Read` row.
- `pi -e /Users/drewritter/prime-rad/superpowers` loads the Superpowers Pi
  extension and injects the bootstrap context.
- Pi's local skills documentation and resource loader show that default skill
  discovery includes global and project skill roots, while explicit
  `--skill <path>` entries still load under `--no-skills`.
- Drew's global Pi `auth.json`, inspected with values redacted, contains both
  OAuth credentials and an `api_key` credential. Pi's auth loader supports
  runtime `--api-key`, API-key credentials in `auth.json`, OAuth credentials,
  environment variables, and provider fallback.

These facts reduce the unknown surface to interactive Gauntlet driving and
run-local auth provisioning.

## Non-goals

- Public CI live Pi runs. Like all live Quorum evals, Pi runs remain
  trusted-maintainer operations.
- Reusing global `~/.pi/agent/auth.json`, settings, packages, sessions, or
  extensions.
- Copying OAuth tokens into Quorum run directories.
- Token/cost capture for Pi in v1. `capture.py` already treats Pi token parsing
  as unsupported.
- A generic auth abstraction across all Coding-Agents.
- A generic package-source abstraction for all Coding-Agents.
- Supporting optional Pi tools such as third-party subagent or todo packages in
  v1. The target should start with built-in Pi coding tools and Superpowers
  resources.

## Current harness model

Quorum already has the extension points needed for Pi:

- `coding-agents/<name>.yaml` defines the target binary, per-run config env
  var, session-log directory, log glob, normalizer, required env, and timeout.
- `<name>-context/launch-agent` bakes cwd, config dir, auth env file, extension
  path, and tool flags into one executable so the Gauntlet-Agent can launch the
  Coding-Agent reliably.
- `<name>-context/HOWTO.md` tells the Gauntlet-Agent how to launch, observe,
  wait for, and shut down the Coding-Agent.
- `quorum/runner.py` creates a fresh per-run config dir before scenario setup.
- `quorum/capture.py` already returns capture metadata and already filters Pi
  logs by launch cwd.
- `quorum/normalizers.py` already registers `normalizer: pi`.
- `bin/_skill_predicate.jq` already treats canonical `Read` calls on
  `skills/.../SKILL.md` as skill invocations, which is the right shape for Pi.

Pi should fit this model with one target-specific provisioning hook, not a new
runner architecture.

## Pi runtime setup

Add `coding-agents/pi.yaml`:

```yaml
name: pi
binary: pi
agent_config_env: PI_CODING_AGENT_DIR
session_log_dir: "${PI_CODING_AGENT_DIR}/sessions"
session_log_glob: "*.jsonl"
normalizer: pi
required_env:
  - SUPERPOWERS_ROOT
  - PI_PROVIDER
  - PI_MODEL
  - PI_API_KEY
max_time: 10m
max_concurrency: 1
```

`PI_CODING_AGENT_DIR` is Quorum-owned and points at:

```text
<run>/coding-agent-config/
```

The runner writes Pi's session files under:

```text
<run>/coding-agent-config/sessions/*.jsonl
```

The flat glob is intentional. Live Pi `0.78.0` writes session files directly
under `--session-dir`, and the explicit session directory means Quorum does not
need to scan nested user-state paths.

Keep `max_concurrency: 1` in v1. Pi can use shared provider credentials and
model backends that may rate-limit or refresh auth. Once a few live sweeps are
stable, concurrency can be revisited.

## Auth and isolation

The Pi target must not use Drew's global `~/.pi/agent/auth.json`.

Runner provisioning should create these files in the per-run
`PI_CODING_AGENT_DIR`:

```text
auth.json
settings.json
pi.env
sessions/
```

`auth.json` should store an API-key credential by provider, but should not
store the secret value directly:

```json
{
  "azure-openai-responses": {
    "type": "api_key",
    "key": "$PI_API_KEY"
  }
}
```

The provider key comes from `PI_PROVIDER`. The literal `$PI_API_KEY` value is
resolved by Pi at runtime through its config-value resolver. This keeps
`auth.json` useful while avoiding a checked run artifact that directly embeds
the API key in JSON.

`pi.env` should be chmod `0600` and contain shell exports for:

```bash
PI_PROVIDER=<provider>
PI_MODEL=<model>
PI_API_KEY=<secret>
# Provider-specific non-key env when required, for example:
AZURE_OPENAI_BASE_URL=<url>
AZURE_OPENAI_RESOURCE_NAME=<name>
AZURE_OPENAI_API_VERSION=<version>
AZURE_OPENAI_DEPLOYMENT_NAME_MAP=<map>
```

The generated launcher sources `pi.env` immediately before starting Pi. This
matches the existing Gemini design problem: tmux may strip arbitrary env vars,
so the launcher cannot rely on inherited secrets. Run directories remain
secret-bearing live-eval artifacts and must not be published or committed.

`settings.json` should pin the default provider and model for clarity, but the
launcher should also pass `--provider "$PI_PROVIDER" --model "$PI_MODEL"` so
the live run does not depend on settings discovery.

Do not call `pi --api-key "$PI_API_KEY"` in the launcher. The runtime override
works, but command-line arguments can be visible in process listings. A
run-local `auth.json` with `$PI_API_KEY` indirection gives Pi the same key
without putting the secret on argv.

## Superpowers loading

Pi can load the local Superpowers package directly:

```bash
pi --extension "$SUPERPOWERS_ROOT"
```

Live discovery proved that passing the package root is sufficient: Pi reads the
parent repo's `package.json` `pi` manifest, loads `.pi/extensions/superpowers.ts`,
and receives the extension-provided `resources_discover` and bootstrap context.

The launcher should use explicit extension and skill loading, while suppressing
ambient extension and skill discovery:

```bash
pi \
  --no-extensions \
  --extension "$SUPERPOWERS_ROOT" \
  --no-skills \
  --skill "$SUPERPOWERS_ROOT/skills" \
  --no-context-files \
  ...
```

Pi help states that `--no-extensions` disables discovered extensions but does
not disable explicit `--extension` paths. This keeps the run from depending on
global or project-local Pi packages while still loading the local Superpowers
checkout under test.

Use `--no-skills --skill "$SUPERPOWERS_ROOT/skills"` instead of relying on
default skill discovery. Pi's default skill roots include global locations such
as `~/.agents/skills`, which could make `skill-called superpowers:<name>` pass
without proving the local Superpowers checkout under test provided the skill.
Explicit `--skill` paths remain additive under `--no-skills`, so this preserves
skill behavior while isolating it to `SUPERPOWERS_ROOT`.

Also pass `--no-context-files`. Pi otherwise discovers `AGENTS.md` and
`CLAUDE.md` from its config dir and cwd ancestors, which would reintroduce
ambient repo instructions into the agent-under-test session.

The runner should validate that `SUPERPOWERS_ROOT` contains:

```text
package.json
.pi/extensions/superpowers.ts
skills/using-superpowers/SKILL.md
skills/using-superpowers/references/pi-tools.md
```

This is a local-source assertion, not evidence that the extension ran. The
bootstrap scenario supplies behavioral evidence.

## Launcher and HOWTO

The generated `pi-context/launch-agent` should run, in effect:

```bash
cd "$QUORUM_AGENT_CWD"
set -a
. "$PI_ENV_FILE"
set +a
exec env \
  PI_CODING_AGENT_DIR="$PI_CODING_AGENT_DIR" \
  PI_OFFLINE=1 \
  PI_TELEMETRY=0 \
  pi \
    --session-dir "$PI_CODING_AGENT_DIR/sessions" \
    --provider "$PI_PROVIDER" \
    --model "$PI_MODEL" \
    --no-extensions \
    --extension "$SUPERPOWERS_ROOT" \
    --no-skills \
    --skill "$SUPERPOWERS_ROOT/skills" \
    --no-context-files \
    --tools read,bash,edit,write,grep,find,ls \
    "$@"
```

The `cd`, config dir, env file, model selection, session dir, explicit
Superpowers extension, and enabled built-in tools live in the launcher so the
Gauntlet-Agent launches Pi with one command and cannot accidentally start Pi
from the scratch directory.

The HOWTO should tell the Gauntlet-Agent:

- start with the generated `"$QUORUM_LAUNCH_AGENT"` command;
- observe logs under `$PI_CODING_AGENT_DIR/sessions/*.jsonl`;
- trust JSONL logs over a stale screen;
- use `watch_logs` and `wake_on_idle_log` instead of repeated sleep polling;
- treat Pi tool names as lowercase in the raw session but Quorum-normalized in
  `coding-agent-tool-calls.jsonl`;
- shut down with Ctrl+D or `/exit` if Pi accepts it.

## Capture and diagnostics

Pi capture should produce the same Quorum artifact as every other target:

```text
<run>/coding-agent-tool-calls.jsonl
```

Raw Pi sessions live under:

```text
<run>/coding-agent-config/sessions/*.jsonl
```

`capture.py` already filters Pi sessions by launch cwd, using the first-line
session header. Keep that behavior. It protects scenarios that override
`.quorum-launch-cwd` and protects against the QA agent launching Pi from the
wrong directory.

Pi should fail closed like Antigravity, with Pi-specific attribution based on
the run-local session directory:

- If no new Pi session file appears after capture, the verdict is
  `indeterminate` with `error.stage = "capture"`.
- If new Pi session files appear but have malformed or missing session headers,
  the verdict is `indeterminate` with a distinct capture message.
- If a Pi session file appears under the run-local session dir but its header
  cwd is not the expected launch cwd, the verdict is `indeterminate` with
  `error.stage = "qa-agent-misconfigured"`, naming the misplaced session. Unlike
  Codex, Pi does not need an "inside the run dir" guard here: a new file under
  `<run>/coding-agent-config/sessions/` is already attributable to this run.
- If Pi session files match the launch cwd but normalize to zero tool-call rows,
  the verdict is `indeterminate` with a distinct zero-row capture message.

The generic `capture_empty` compose path remains useful for other targets, but
Pi should not allow file-only scenarios to pass when trace capture is broken.

## Tool mapping and skill checks

The existing Pi normalizer maps:

| Pi raw tool | Quorum canonical tool |
| --- | --- |
| `read` | `Read` |
| `write` | `Write` |
| `edit` | `Edit` |
| `bash` | `Bash` |
| `grep` | `Grep` |
| `find` | `Glob` |
| `ls` | `Glob` |

Unknown Pi tool names should be preserved rather than dropped. Optional tools
such as `subagent`, `todo`, and `manage_todo_list` are already treated as
native if they appear, but v1 should not depend on them.

The shared skill predicate already recognizes canonical `Read` calls on:

```text
skills/<skill>/SKILL.md
skills/superpowers/<skill>/SKILL.md
```

Add Pi-named tests for that behavior so later edits do not accidentally treat
this as Antigravity-only coverage. The bootstrap scenario should also assert a
`Read` path under the exact `SUPERPOWERS_ROOT` checkout, because the generic
predicate intentionally accepts any matching skill path.

## Bootstrap scenario

Add a Pi-only scenario:

```text
scenarios/pi-superpowers-bootstrap/
  story.md
  setup.sh
  checks.sh
```

The scenario should prove behavioral integration, not just file presence:

- Pi starts from the generated launcher.
- Superpowers skill context is active, proven by a normalized `Read` from the
  exact local `SUPERPOWERS_ROOT` skill tree.
- Pi follows the Superpowers instruction to load a relevant skill before
  editing.
- Pi writes a small requested artifact in the workdir.
- The normalized trace shows `Read` for
  `$SUPERPOWERS_ROOT/skills/brainstorming/SKILL.md`.
- The normalized trace shows a `Write` call for `PI_SUPERPOWERS_OK.md`, so the
  ordering check cannot pass vacuously.
- The normalized trace shows `superpowers:brainstorming` before the write
  operation.

This scenario should use `# coding-agents: pi` so it does not affect existing
Claude, Codex, or Antigravity sweeps.

## Testing strategy

Static tests before live evals:

- config-loader coverage for `coding-agents/pi.yaml`;
- launcher/context substitution for `$PI_CODING_AGENT_DIR`, `$PI_ENV_FILE`,
  `$SUPERPOWERS_ROOT`, and `$QUORUM_LAUNCH_AGENT`;
- Pi runner seeding writes `auth.json`, `settings.json`, `pi.env`, and
  `sessions/` under the isolated config dir;
- `auth.json` stores `$PI_API_KEY`, not the actual secret;
- `auth.json` and `pi.env` are chmod `0600`;
- success-path unit tests patch `shutil.which("pi")` so static tests do not
  depend on the local host having Pi installed;
- provider-specific env is validated and copied for providers that require it,
  starting with `azure-openai-responses`;
- missing `PI_PROVIDER`, `PI_MODEL`, `PI_API_KEY`, and `SUPERPOWERS_ROOT`
  produce setup-stage indeterminate failures;
- Pi Superpowers source validation checks the package manifest, extension, and
  Pi tool-mapping reference;
- no-session, malformed-header, zero-normalized-row, and misplaced-cwd Pi
  diagnostics;
- golden normalizer coverage from a sanitized Pi transcript containing
  `session`, `model_change`, `thinking_level_change`, assistant `toolCall`,
  `toolResult`, and assistant final answer rows;
- Pi-named trace-tool coverage for `skill-called` and `skill-before-tool`
  through canonical `Read` rows;
- `uv run quorum check` validates the Pi bootstrap scenario.

Static verification:

```bash
uv run ruff check
uv run ty check
uv run quorum check
uv run pytest
```

Live acceptance can use any maintainer-supplied API-key provider/model pair.
For example:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers \
PI_PROVIDER=openai \
PI_MODEL=gpt-5.5 \
PI_API_KEY=... \
uv run quorum run scenarios/pi-superpowers-bootstrap --coding-agent pi
uv run quorum show <run>
```

The first passing live run should be inspected manually before any broad sweep:

- raw session file exists under `<run>/coding-agent-config/sessions/`;
- first session row cwd equals the resolved launch cwd;
- normalized trace contains `Read` for
  `$SUPERPOWERS_ROOT/skills/brainstorming/SKILL.md`;
- normalized trace contains the requested `Write`;
- verdict is `pass`;
- `coding-agent-token-usage.json` is absent, as expected for Pi v1.

## Open risks

- Live acceptance on 2026-06-03 passed with
  `PI_PROVIDER=openai`, `PI_MODEL=gpt-5.5`, and `PI_API_KEY` sourced from the
  repo-local `OPENAI_API_KEY`; the run proved the run-local `$PI_API_KEY`
  `auth.json` indirection works interactively under Gauntlet's TUI adapter.
- Pi context-extension messages are injected into runtime context but are not
  persisted as ordinary JSONL session rows. Do not use the internal
  `superpowers:using-superpowers bootstrap for pi` marker as a deterministic
  run check; use observable local skill reads instead.
- Provider/model choice is maintainer-supplied. Bad combinations should fail as
  setup/auth diagnostics, not as misleading Superpowers failures.
