# OpenCode Quorum Coding-Agent Target - design specification

**Linear:** PRI-2046
**Status:** Specification for implementation planning.
**Date:** 2026-06-03
**Context:** Superpowers already supports OpenCode through
`.opencode/plugins/superpowers.js` and OpenCode's native `skill` tool. Quorum
does not yet expose OpenCode as a first-class `--coding-agent opencode` target.

---

## Goal

Add `opencode` as a first-class Quorum Coding-Agent target so existing
behavioral scenarios can exercise Superpowers inside OpenCode.

The harness should be reproducible and isolated from Drew's personal OpenCode
state. Each run gets a Quorum-owned OpenCode home under the run directory,
installs Superpowers from local `SUPERPOWERS_ROOT`, launches OpenCode through a
generated one-line launcher, exports the resulting OpenCode session JSON, and
normalizes tool calls into the existing `coding-agent-tool-calls.jsonl` schema.

Expected maintainer command shape:

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
uv run quorum run scenarios/<scenario> --coding-agent opencode
```

## Non-goals

- Running live OpenCode evals in public CI.
- Reusing global `~/.config/opencode`, `~/.local/share/opencode`, or any other
  host OpenCode state.
- Installing Superpowers through the git-backed public OpenCode plugin spec in
  v1. The harness should test the local checkout under `SUPERPOWERS_ROOT`.
- Parsing OpenCode's SQLite database as the primary transcript source.
- Rewriting Quorum's Coding-Agent config model.
- Generalizing all agent capture into a new backend interface before OpenCode
  needs it.
- Token/cost accounting in v1. OpenCode export includes token metadata, but the
  initial target only needs behavioral tool-call capture.

## Evidence from local probes

OpenCode CLI `1.15.10` is installed locally.

The existing Superpowers OpenCode non-model tests pass:

```bash
bash tests/opencode/run-tests.sh
```

Those tests verify the plugin symlink layout, bootstrap caching, skill
directory registration, and basic plugin syntax.

A focused isolated smoke using the Superpowers test fixture successfully loaded
the native OpenCode `skill` tool and invoked `brainstorming`. The exported
session JSON contained a tool part like:

```json
{
  "type": "tool",
  "tool": "skill",
  "state": {
    "status": "completed",
    "input": {
      "name": "brainstorming"
    }
  }
}
```

`OPENCODE_CONFIG_DIR` alone is not enough isolation. With only
`OPENCODE_CONFIG_DIR` set, `opencode debug paths` still reports data, log,
config, state, and cache paths under the user's normal home. With isolated
`HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`,
`XDG_CACHE_HOME`, `TMPDIR`, and `OPENCODE_CONFIG_DIR`, OpenCode writes under
the temp home except for platform-owned process details:

```text
data   <home>/.local/share/opencode
log    <home>/.local/share/opencode/log
config <home>/.config/opencode
state  <home>/.local/state/opencode
db     <home>/.local/share/opencode/opencode.db
tmp    <home>/.tmp
```

`opencode run -i --dangerously-skip-permissions` boots in a PTY with the
isolated Superpowers plugin loaded. It creates an OpenCode session row before
any prompt is submitted and exits cleanly via `/exit` plus Enter. A bare empty
interactive launch exports as:

```json
{
  "info": {
    "id": "ses_...",
    "directory": "/private/.../test-project",
    "tokens": {
      "input": 0,
      "output": 0,
      "reasoning": 0,
      "cache": {
        "read": 0,
        "write": 0
      }
    }
  },
  "messages": []
}
```

`opencode session list --format json` should be run from the launch cwd and
with the same isolated environment. It then lists sessions associated with that
project directory. The implementation should still realpath-filter by
`directory` because the database can contain multiple sessions.

`opencode export <sessionID>` writes pure JSON to stdout and a progress line to
stderr. Runner code can capture stdout directly without stripping terminal
noise.

## Current Quorum model

Quorum already has most extension points OpenCode needs:

- `coding-agents/<name>.yaml` defines the target binary, config env var,
  session-log directory, log glob, normalizer, required env, timeout, and
  optional concurrency cap.
- `<name>-context/launch-agent` bakes cwd, config/home, and permissive flags
  into one generated executable.
- `<name>-context/HOWTO.md` tells the Gauntlet-Agent to launch the Coding-Agent
  through that generated executable.
- `quorum/runner.py` allocates `<run>/coding-agent-config`, seeds target state,
  runs setup/pre-checks, snapshots logs, invokes Gauntlet, captures logs, then
  runs post-checks.
- `quorum/capture.py` normalizes new files created after the snapshot into
  `coding-agent-tool-calls.jsonl`.
- `quorum/normalizers.py` maps backend-specific tool calls to shared canonical
  names such as `Skill`, `Agent`, `Bash`, `Read`, `Edit`, `Grep`, and `Glob`.

OpenCode should fit this model with target-specific provisioning and a narrow
post-Gauntlet export step. It should not require a new runner architecture.

## OpenCode runtime setup

Add `coding-agents/opencode.yaml`:

```yaml
name: opencode
binary: opencode
agent_config_env: OPENCODE_QUORUM_HOME
session_log_dir: "${OPENCODE_QUORUM_HOME}/.quorum/session-exports"
session_log_glob: "[0-9]*-ses_*.json"
normalizer: opencode
required_env:
  - SUPERPOWERS_ROOT
max_time: 10m
max_concurrency: 1
```

`OPENCODE_QUORUM_HOME` is Quorum-owned and points at
`<run>/coding-agent-config`. It is intentionally not an OpenCode-native env var.
The generated launcher derives OpenCode's actual home/config variables from it.

Runner provisioning should create:

```text
<home>/.config/opencode
<home>/.local/share/opencode
<home>/.local/state/opencode
<home>/.cache
<home>/.tmp
<home>/.quorum/session-exports
```

The launcher should run, in effect:

```bash
cd "$QUORUM_AGENT_CWD"
env_args=(
  "PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  "TERM=${TERM:-xterm-256color}"
  "LANG=${LANG:-C.UTF-8}"
)
for name in \
  OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY \
  GEMINI_API_KEY GOOGLE_API_KEY \
  AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
  if [[ -n "${!name-}" ]]; then
    env_args+=("$name=${!name}")
  fi
done
exec env -i \
  "${env_args[@]}" \
  HOME="$OPENCODE_QUORUM_HOME" \
  XDG_CONFIG_HOME="$OPENCODE_QUORUM_HOME/.config" \
  XDG_DATA_HOME="$OPENCODE_QUORUM_HOME/.local/share" \
  XDG_STATE_HOME="$OPENCODE_QUORUM_HOME/.local/state" \
  XDG_CACHE_HOME="$OPENCODE_QUORUM_HOME/.cache" \
  TMPDIR="$OPENCODE_QUORUM_HOME/.tmp" \
  OPENCODE_CONFIG_DIR="$OPENCODE_QUORUM_HOME/.config/opencode" \
  opencode run -i --dangerously-skip-permissions "$@"
```

The full-screen default `opencode [project]` path is not the v1 launcher. The
`run -i` mode explicitly supports `--dangerously-skip-permissions`, was smoked
in a PTY, and still creates exportable sessions.

## Superpowers install

Provisioning should mirror the layout already used by
`superpowers/tests/opencode/setup.sh`:

```text
$OPENCODE_CONFIG_DIR/superpowers/
$OPENCODE_CONFIG_DIR/superpowers/skills/
$OPENCODE_CONFIG_DIR/superpowers/.opencode/plugins/superpowers.js
$OPENCODE_CONFIG_DIR/plugins/superpowers.js -> ../superpowers/.opencode/plugins/superpowers.js
```

The plugin computes the Superpowers skills directory relative to its own file:

```js
const superpowersSkillsDir = path.resolve(__dirname, '../../skills');
```

So the Quorum layout must preserve the package shape. v1 should copy the plugin
file and copy the `skills/` tree from `SUPERPOWERS_ROOT` into the per-run home.
Do not symlink `skills/` back to the source checkout by default: OpenCode runs
with dangerous permissions, and a symlink lets the agent follow the path back
into the real Superpowers checkout. Copying evaluates a per-run snapshot of the
local checkout and preserves the isolation guarantee.

`SUPERPOWERS_ROOT` must contain:

- `.opencode/plugins/superpowers.js`
- `skills/using-superpowers/SKILL.md`
- `skills/brainstorming/SKILL.md`

Provisioning should validate that:

- `opencode` is on `PATH`.
- `node --check` passes for the staged plugin file when `node` is available.
- `$OPENCODE_CONFIG_DIR/plugins/superpowers.js` is a symlink or file that
  resolves to an existing plugin file.
- `$OPENCODE_CONFIG_DIR/superpowers/skills/using-superpowers/SKILL.md` exists.
- the source `skills/` tree does not contain symlinks.
- the staged plugin, staged plugin link, and every staged skill path resolve
  under `OPENCODE_QUORUM_HOME`.

The local smoke found no OpenCode-specific API key in the environment, and
OpenCode still completed a skill-tool run through its installed default
provider. Therefore `opencode.yaml` should not invent a required API-key env
var. However, runner provisioning should still run a model-invoking OpenCode
preflight in a throwaway OpenCode home and throwaway cwd before Gauntlet starts.
That preflight should use the same isolation variables, ask OpenCode to reply
with exactly `OK`, and fail with a setup-stage diagnostic when the CLI/provider
cannot answer. The real run home must remain session-export-free until after
the capture snapshot.

OpenCode process envs should be allowlisted, not inherited wholesale. In
particular, do not pass `SUPERPOWERS_ROOT`, `QUORUM_*`, or host OpenCode home
variables into the agent under test. Preserve only the isolated OpenCode home
variables, basic terminal/path variables, and explicit provider/auth variables
needed for the maintainer's configured provider.

Supported v1 auth inputs are therefore explicit provider/auth env vars in that
allowlist or an OpenCode provider setup that still works under an isolated
home. Preflight failures should include the OpenCode version when available and
point maintainers at the allowlisted provider envs rather than failing later as
an opaque Gauntlet or capture error.

This v1 target validates the local staged plugin/package layout. It does not
validate OpenCode's public git-backed plugin install path from `opencode.json`.
If that install path needs coverage, add a separate scenario or preflight that
uses OpenCode's own plugin installation mechanism.

## Session export and capture

OpenCode's durable session store is SQLite under:

```text
$XDG_DATA_HOME/opencode/opencode.db
```

The v1 harness should not parse that database directly. Instead, after Gauntlet
returns and before `capture_tool_calls`, the runner should export OpenCode
sessions to the configured `session_log_dir`.

Add target-specific helpers in `quorum/capture.py` or a focused new module
such as `quorum/opencode_capture.py`:

```python
snapshot_opencode_sessions(
    opencode_home: Path,
    launch_cwd: Path,
) -> set[str]

export_opencode_sessions(
    opencode_home: Path,
    export_dir: Path,
    launch_cwd: Path,
    snapshot: set[str],
) -> tuple[Path, ...]
```

`snapshot_opencode_sessions` should run after launch cwd resolution and before
Gauntlet starts. It should list sessions with the same isolated environment,
filter by `launch_cwd` realpath, and return the matching session IDs that
already existed.

The export helper should:

1. Build the isolated OpenCode environment from `opencode_home`.
2. Run `opencode session list --format json` with `cwd=launch_cwd`.
3. Parse the JSON session list.
4. Keep sessions whose `directory` realpath equals `launch_cwd` realpath.
5. Drop session IDs that were present in the pre-Gauntlet snapshot.
6. Sort new sessions by `created` from `session list`, falling back to the
   exported `info.time.created` value. To make that fallback real, export any
   sessions missing list-level creation times to memory or temp files first,
   then sort and write final files. If multiple new sessions still have no
   usable ordering field, fail closed with a capture-stage diagnostic.
7. For each matching new session, run `opencode export <sessionID>` with the
   same env and cwd.
8. Write stdout to `<export_dir>/<created>-<sessionID>.json`.
9. Write `<export_dir>/opencode-session-export-manifest.json` containing the
   raw session-list rows, snapshot IDs, matched IDs, skipped IDs, realpath
   comparisons, export stderr, and exported filenames.
10. Return the exported session JSON paths, excluding the manifest.

The normal `snapshot_dir` / `capture_tool_calls` path can then diff the export
directory. This keeps the existing normalized trace artifact unchanged while
letting OpenCode use a CLI export step before file diffing.

The manifest intentionally lives in the export directory for triage, but the
OpenCode `session_log_glob` must only match exported session files. Do not use
`*.json`, or the manifest becomes a fake transcript source log.

If multiple new matching sessions exist for the same launch cwd, export all of
them only when they can be ordered by creation time. Tool-call normalization
then preserves that order through the prefixed filenames. This avoids false
passes or false failures in ordering checks such as `skill-before-tool`.

## Normalization

Add `normalizer: opencode` to `quorum/normalizers.py`.

The normalizer should accept OpenCode export JSON shaped as:

```json
{
  "info": {
    "id": "ses_..."
  },
  "messages": [
    {
      "info": {
        "role": "assistant"
      },
      "parts": [
        {
          "type": "tool",
          "tool": "skill",
          "state": {
            "input": {
              "name": "brainstorming"
            }
          }
        }
      ]
    }
  ]
}
```

Only tool parts should produce rows. Non-tool parts, reasoning, text, and
step-start/step-finish parts should be ignored.

OpenCode tool names should map to Quorum canonical names:

```python
OPENCODE_TOOL_MAP = {
    "skill": "Skill",
    "task": "Agent",
    "bash": "Bash",
    "read": "Read",
    "write": "Write",
    "edit": "Edit",
    "apply_patch": "Edit",
    "grep": "Grep",
    "glob": "Glob",
    "todowrite": "TodoWrite",
    "webfetch": "WebFetch",
    "websearch": "WebSearch",
}
```

For `skill`, normalize args so existing `skill-called superpowers:<name>`
checks work:

```json
{"tool": "Skill", "args": {"skill": "superpowers:brainstorming"}, "source": "native"}
```

The raw OpenCode input should also be preserved where useful:

```json
{
  "tool": "Skill",
  "args": {
    "skill": "superpowers:brainstorming",
    "name": "brainstorming",
    "raw_input": {
      "name": "brainstorming"
    }
  },
  "source": "native"
}
```

For `task`, use `Agent` as the canonical tool because OpenCode's subagent
dispatch primitive is the same behavioral evidence Quorum scenarios expect from
Claude's `Agent`.

For shell and file tools, keep the OpenCode input payload under `args`, with
light normalization only when the shared check tools already expect a field
name. For example, `bash` should expose `args.command`, write/edit/read tools
should expose `args.file_path` when OpenCode provides an equivalent `file`,
`path`, `filePath`, or `file_path` field, and `apply_patch` should parse patch
headers into at least `args.file_path` and preferably `args.file_paths`.
Golden tests should include a sanitized real OpenCode export fixture before
broadening mappings beyond the observed native `skill` shape.

## Data flow

1. `uv run quorum run scenarios/foo --coding-agent opencode` loads
   `coding-agents/opencode.yaml`.
2. Runner allocates `<run>/coding-agent-config`.
3. Runner calls `_seed_opencode_config`.
4. `_seed_opencode_config` creates isolated home/XDG/config/export
   directories, validates `SUPERPOWERS_ROOT`, stages the OpenCode Superpowers
   package layout, and rejects unexpected pre-existing exports.
5. Runner runs an OpenCode provider preflight in a throwaway OpenCode home.
6. Scenario setup and pre-checks run normally.
7. Runner resolves `launch_cwd`, including `.quorum-launch-cwd`.
8. Runner snapshots existing OpenCode session IDs for `launch_cwd`.
9. Runner populates `opencode-context` with literal paths for
   `$QUORUM_LAUNCH_AGENT`, `$QUORUM_AGENT_CWD`, and `$OPENCODE_QUORUM_HOME`.
10. Runner snapshots
   `${OPENCODE_QUORUM_HOME}/.quorum/session-exports/[0-9]*-ses_*.json`.
11. Gauntlet drives the QA agent through the generated launcher.
12. OpenCode writes session state to the isolated SQLite database.
13. Runner exports new matching OpenCode sessions into the export directory.
14. Runner captures new exported JSON files and normalizes tool calls.
15. Runner optionally writes OpenCode token usage in a later iteration.
16. Runner applies OpenCode capture diagnostics, then runs post-checks.
17. Verdict composition uses the same three-valued model as other targets.

## Failure modes

Setup should fail as `indeterminate` with `stage="setup"` when:

- `SUPERPOWERS_ROOT` is missing.
- `SUPERPOWERS_ROOT` lacks required OpenCode plugin or skill files.
- `opencode` is not on `PATH`.
- the isolated OpenCode directory layout cannot be created.
- the staged plugin symlink or file does not resolve.
- staged plugin or skills resolve outside `OPENCODE_QUORUM_HOME`.
- the source skills tree contains symlinks or staged nested paths resolve
  outside `OPENCODE_QUORUM_HOME`.
- the staged plugin has a JavaScript syntax error and `node` is available to
  check it.
- OpenCode's provider/auth preflight cannot produce the expected `OK` response
  in a throwaway isolated home, including timeout.
- provisioning finds session-export files matching the configured session glob
  before the capture snapshot.

Capture should fail as `indeterminate` with `stage="capture"` when:

- no OpenCode sessions matching `launch_cwd` are found after Gauntlet returns.
- matching sessions exist, but none are new relative to the pre-Gauntlet
  session snapshot.
- multiple new matching sessions cannot be ordered by creation time.
- matching sessions exist but export fails.
- export helper wrote files, but the normal file-diff capture did not see them.
- exported session JSON exists but all exports normalize to zero tool-call rows.

The zero-row diagnostic should include exported filenames. This catches cases
where OpenCode launched but the QA agent only opened and exited the TUI, or
where the export format changed and the normalizer no longer recognizes tool
parts.

For scenarios without trace checks, missing/zero OpenCode capture should still
be indeterminate. A file-only scenario should not false-green when the target
transcript is broken.

## Testing strategy

Static/unit coverage should land before live evals:

- config-loader coverage for `coding-agents/opencode.yaml`.
- `_seed_opencode_config` creates isolated `HOME`/XDG/OpenCode directories.
- `_seed_opencode_config` creates isolated `TMPDIR`.
- missing `SUPERPOWERS_ROOT` fails clearly.
- missing OpenCode plugin or required skills fails clearly.
- staged plugin layout mirrors `tests/opencode/setup.sh`.
- staged skills are copied under `OPENCODE_QUORUM_HOME`, not symlinked outside
  it.
- source and staged skill trees reject nested symlink escapes.
- `node --check` failure on staged plugin is surfaced when `node` is available.
- OpenCode provider preflight uses a throwaway home and reports setup failures
  and timeouts clearly.
- generated launcher contains isolated `HOME`, XDG variables,
  `TMPDIR`, `OPENCODE_CONFIG_DIR`, `opencode run -i`, and
  `--dangerously-skip-permissions`.
- generated launcher and Python OpenCode env helpers scrub `SUPERPOWERS_ROOT`,
  `QUORUM_*`, and host OpenCode home variables.
- pre-Gauntlet session snapshot excludes pre-existing sessions from capture.
- export helper runs `opencode session list --format json` with cwd and
  isolated env.
- export helper realpath-filters sessions by launch cwd.
- export helper writes one JSON file per new matching session and writes
  `opencode-session-export-manifest.json`.
- `session_log_glob` captures exported sessions but not
  `opencode-session-export-manifest.json`.
- export helper orders multiple new matching sessions by creation time.
- export helper falls back to exported `info.time.created` when session-list
  rows lack creation times.
- export manifest includes raw rows, skipped non-matches, realpath decisions,
  export stderr, and exported filenames.
- export helper surfaces export failures.
- OpenCode normalizer golden coverage for `skill`, `bash`, `read`,
  `apply_patch`, `grep`, `glob`, `task`, `todowrite`, and `webfetch`.
- OpenCode normalizer coverage proves write/edit/read path fields work with
  existing implementation-path check tools.
- `skill-called superpowers:brainstorming` works against OpenCode-normalized
  rows.
- runner diagnostics distinguish no matching session from exported zero rows.
- launch-cwd filtering handles macOS `/var` to `/private/var` realpath
  differences.

Add one OpenCode-specific smoke scenario:

```text
scenarios/opencode-superpowers-bootstrap/
  story.md
  setup.sh
  checks.sh
```

The scenario should restrict itself with:

```bash
# coding-agents: opencode
```

The story should mirror the existing Codex and Antigravity bootstrap scenarios:
ask the agent a naive "react todo list" prompt without mentioning Superpowers.
The checks should assert:

- `skill-called superpowers:brainstorming`
- `opencode-plugin-installed`

Before implementation completion, run:

```bash
uv run ruff check
uv run ty check
uv run quorum check
uv run pytest
```

Then run the trusted live smoke:

```bash
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
uv run quorum run scenarios/opencode-superpowers-bootstrap --coding-agent opencode
uv run quorum show
```

If that smoke is noisy or model-auth dependent on a machine, record the exact
OpenCode version, command, run directory, verdict, and failure reason in the
implementation summary rather than weakening the harness.
