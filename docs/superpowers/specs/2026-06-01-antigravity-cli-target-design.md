# Antigravity CLI target - design specification

**Status:** Specification, revised after parallel reviewer pass. Ready for Drew
review. Not yet implemented.
**Date:** 2026-06-01
**Context:** Google Antigravity 2.0 CLI support in Superpowers has landed on
`superpowers` `dev`, but not yet `main`. Quorum needs a first-class
Antigravity Coding-Agent target so we can test that support against the same
behavioral scenarios used for Claude and Codex.

---

## Goal

Add `antigravity` as a first-class Quorum Coding-Agent target with parity to
the existing Claude and Codex harnesses.

The goal is not to test whether `agy` can answer prompts. The goal is to test
whether Superpowers works inside Antigravity across the same behavioral
scenario classes Quorum already cares about: skill triggering, tool mapping,
subagent behavior, verification reflexes, worktree behavior where applicable,
and trace-backed evidence.

The source contract matches Claude and Codex:

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
uv run quorum run scenarios/<scenario> --coding-agent antigravity
```

`SUPERPOWERS_ROOT` remains the canonical local checkout under test. There is
no Antigravity-specific source override in this design. If Quorum later needs
URL-source testing, that should be designed as a generic harness capability,
with clear caveats that not every Coding-Agent can install from URLs in the
same way.

## Non-goals

- SDK-based Antigravity driving. This design tests the CLI/plugin surface.
- Public CI or fully headless auth support. Antigravity live evals are
  trusted-maintainer operations.
- Token/cost capture for Antigravity. The local Antigravity transcript and
  conversation files do not currently provide a stable usage surface.
- A generic plugin-source abstraction across all Coding-Agents.
- Rewriting existing Claude or Codex setup.
- Claiming every existing scenario supports Antigravity on day one. Existing
  scenarios need an explicit compatibility audit before they are included in
  Antigravity sweeps.

## Current harness model

Quorum already has the right extension points:

- `coding-agents/<name>.yaml` selects the CLI binary, config env var, session
  log directory, log glob, normalizer, required environment, and default
  timeout.
- `<name>-context/launch-agent` bakes cwd, config-dir, and dangerous-mode
  flags into one command so the Gauntlet-Agent cannot accidentally launch from
  the wrong directory.
- `<name>-context/HOWTO.md` tells the Gauntlet-Agent how to launch, observe,
  wait for, and shut down the Coding-Agent.
- `quorum/normalizers.py` converts backend-specific session logs into canonical
  `coding-agent-tool-calls.jsonl` rows.
- `bin/_skill_predicate.jq` is the shared definition of "skill invocation" for
  `skill-called`, `skill-before-tool`, and related trace checks.

Antigravity should fit this model rather than adding a new runner architecture.

## Antigravity runtime setup

Add `coding-agents/antigravity.yaml`:

```yaml
name: antigravity
binary: agy
agent_config_env: ANTIGRAVITY_CONFIG_DIR
session_log_dir: "${ANTIGRAVITY_CONFIG_DIR}/.gemini/antigravity-cli/brain"
session_log_glob: "**/transcript.jsonl"
normalizer: antigravity
required_env:
  - SUPERPOWERS_ROOT
max_time: 10m
```

`ANTIGRAVITY_CONFIG_DIR` is a Quorum-owned per-run directory under
`<run>/coding-agent-config`, analogous to `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.
The Antigravity launcher points `agy` at an isolated `.gemini` tree inside that
directory.

Antigravity provisioning must be runner-level, not a scenario `setup.sh`
helper. Quorum creates the per-agent config dir before scenario setup, and
scenario setup does not receive `ANTIGRAVITY_CONFIG_DIR`; installing
Superpowers therefore belongs in the same runner seeding path that already has
the config dir in hand.

The launcher should run, in effect:

```bash
cd "$QUORUM_AGENT_CWD"
exec env \
  ANTIGRAVITY_CONFIG_DIR="$ANTIGRAVITY_CONFIG_DIR" \
  AGY_CLI_DISABLE_AUTO_UPDATE=true \
  agy \
    --gemini_dir="$ANTIGRAVITY_CONFIG_DIR/.gemini" \
    --dangerously-skip-permissions \
    --log-file "$ANTIGRAVITY_CONFIG_DIR/agy.log" \
    "$@"
```

The live Quorum target should be interactive, matching Claude and Codex. Do
not use `--print` in the main launcher: `--print` runs a single
non-interactive prompt, which would test prompt-answering rather than letting
the Gauntlet-Agent drive the Coding-Agent through the normal scenario flow.
`--print` is still useful for setup preflight and maintainer smoke tests, where
one exact-response probe can verify `agy` auth and config isolation quickly.

Do not use `--app_data_dir` in v1. Official Antigravity SDK docs expose
`app_data_dir`, and the installed binary contains related strings, but the CLI
does not document it. A live canary showed `--gemini_dir` alone isolates config,
app data, logs, conversations, and transcripts under the requested `.gemini`
tree.

## Unsupported Antigravity surface

`--gemini_dir` is required for Quorum isolation, but it is not documented in
official Antigravity CLI docs or in the public `google-antigravity` repositories
as of 2026-06-01.

The implementation should keep this dependency contained:

- Only the Antigravity launcher and runner provisioning code should know about
  `--gemini_dir`.
- Docs should call it out as a hidden compatibility dependency.
- A fast auth/isolation preflight should verify that `agy --gemini_dir=<tmp>`
  writes config and transcripts under a throwaway `<tmp>/.gemini`. This
  preflight must not use the run's `ANTIGRAVITY_CONFIG_DIR`, because Quorum's
  capture snapshots new transcript filenames; creating a transcript before the
  snapshot can hide the real run if Antigravity later appends to the same file.
  The preflight may use `--print-timeout <duration> --print <prompt>`; when it
  does, `--print-timeout` must appear before `--print` because observed `agy`
  behavior treats arguments after `--print` as prompt content.
- Auth/keyring failures from this preflight should produce an Antigravity auth
  diagnostic, not a generic missing-transcript failure. Official docs describe
  system-keyring auth with browser/SSH OAuth fallback, and headless/locked
  keyring failures are expected maintainer-environment problems.
- If isolation or capture cannot be proven, the run should become
  `indeterminate` with an explicit Antigravity diagnostic, not a misleading
  "skill was never called" failure.

`AGY_CLI_DISABLE_AUTO_UPDATE=true` should always be set so a live eval does
not update the CLI during a run.

Antigravity writes a `.antigravitycli/` project marker into the launch workdir.
For git-backed fixtures, that marker must not make ordinary `git-clean` checks
fail. After setup and after resolving `launch_cwd`, the runner should add
`.antigravitycli/` to the launch repo's `.git/info/exclude` when `launch_cwd`
is inside a git work tree. This keeps the marker out of `git status --porcelain`
without changing tracked files.

## Superpowers install

Antigravity runner provisioning should install Superpowers from local
`SUPERPOWERS_ROOT` into the isolated Antigravity config dir before the run
starts.

Expected command shape:

```bash
AGY_CLI_DISABLE_AUTO_UPDATE=true \
agy --gemini_dir="$ANTIGRAVITY_CONFIG_DIR/.gemini" \
  plugin install "$SUPERPOWERS_ROOT"
```

With current `agy` behavior, this installs Superpowers under:

```text
$ANTIGRAVITY_CONFIG_DIR/.gemini/config/plugins/superpowers/
```

The official CLI plugin prose still mentions
`~/.gemini/antigravity-cli/plugins`, but the official changelog and current
binary behavior install plugins into shared `.gemini/config/plugins`. The
implementation should assert the actual installed plugin path rather than
depending only on prose docs.

Do not use `agy plugin validate "$SUPERPOWERS_ROOT"` as the validation step.
With current `agy 1.0.3`, `plugin validate` expects a pre-shaped plugin root
with `plugin.json`, while `plugin install "$SUPERPOWERS_ROOT"` succeeds and
generates the installed plugin package under `.gemini/config/plugins`. The
post-install assertion should inspect the generated install, especially
`plugin.json`, `hooks.json`, and `skills/using-superpowers/SKILL.md`.

The runner provisioning should fail clearly if:

- `SUPERPOWERS_ROOT` is missing.
- `agy` is missing.
- `agy plugin install "$SUPERPOWERS_ROOT"` fails.
- The expected plugin files are absent after install.

## Capture and normalization

Antigravity capture produces the same Quorum artifact as every other target:

```text
<run>/coding-agent-tool-calls.jsonl
```

The raw source is:

```text
$ANTIGRAVITY_CONFIG_DIR/.gemini/antigravity-cli/brain/**/.system_generated/logs/transcript.jsonl
```

Set `session_log_dir` to the `brain` directory and `session_log_glob` to
`**/transcript.jsonl` so Quorum's existing snapshot/diff capture path can find
new transcript files.

Add `normalize_antigravity_logs(raw_content: str)`.

The normalizer should be tolerant because the transcript schema is observed,
not guaranteed:

- Parse JSONL line by line.
- Read tool calls from current `agy 1.0.3` top-level `tool_calls[]` entries
  when present.
- Also tolerate older/alternate shapes such as `PLANNER_RESPONSE.tool_calls[]`
  if captured fixtures show them.
- Ignore malformed lines and non-tool rows.
- Preserve unknown Antigravity tool names instead of dropping or guessing.
- Preserve raw tool args under `args.raw_args` while also emitting canonical
  keys used by Quorum checks.

Canonical mappings:

| Antigravity tool | Quorum canonical tool | Notes |
| --- | --- | --- |
| `run_command` | `Bash` | Canonicalize `CommandLine` or `command` to `args.command`. |
| `view_file` | `Read` | Canonicalize `AbsolutePath`, `path`, or `file_path` to `args.file_path`; canonicalize skill markers to `args.is_skill_file`. |
| `write_to_file` | `Write` | Preserve raw args. |
| `replace_file_content` | `Edit` | Preserve raw args. |
| `multi_replace_file_content` | `Edit` | Preserve raw args. |
| `grep_search` | `Grep` | Preserve raw args. |
| `list_dir` | `Glob` | Canonicalize `DirectoryPath` when present. |
| `find_by_name` | `Glob` | Preserve raw args. |
| `invoke_subagent` | `Agent` | Preserve subagent type/name/prompt args. |
| `manage_subagents` | `Agent` when the action launches a subagent; otherwise preserve raw | Current `agy 1.0.3` traces use this name. Do not claim completion/result semantics until real traces are understood. |
| `search_web` | `WebSearch` | Preserve raw args. |
| `read_url_content` | `WebFetch` | Preserve raw args. |
| `manage_task` | `manage_task` | Keep raw until real traces show stable action semantics. |
| `list_permissions` | `list_permissions` | Preserve raw. |

`source` should follow the existing normalizer convention: `Bash` is `shell`;
tools in `NATIVE_TOOLS` are `native`; other mapped or unknown tools may be
`shell` unless the canonical native set is deliberately extended. The important
property is that unknown tool calls remain visible in the trace.

## Skill invocation parity

Existing trace tools cannot require a native `Skill` call. Jesse's
Antigravity support loads skills through Antigravity file-reading behavior,
such as `view_file` on a plugin skill file with `IsSkillFile: true`.

Update the shared skill predicate so all skill trace tools agree that these
count as skill invocations:

- Existing native form:
  `{"tool": "Skill", "args": {"skill": "superpowers:<name>"}}`
- Existing shell-read form:
  Bash/Shell/LocalShellCall command reading `skills/<name>/SKILL.md` or
  `skills/superpowers/<name>/SKILL.md`.
- New Antigravity normalized-read form:
  `{"tool": "Read", "args": {"file_path": ".../skills/<name>/SKILL.md"}}`.
- New Antigravity skill marker form:
  `{"tool": "Read", "args": {"file_path": ".../skills/<name>/SKILL.md", "is_skill_file": true}}`.

The predicate must not treat arbitrary file reads as skill invocations. The
path must identify the skill directory being checked.

The normalizer, not jq, is responsible for normalizing Antigravity casing and
nesting differences. `IsSkillFile`, `isSkillFile`, `is_skill_file`, or nested
metadata should become `args.is_skill_file`. Path-like args such as
`AbsolutePath`, `Path`, `path`, or `file_path` should become `args.file_path`.
The original args should remain available under `raw_args`.

Skill path detection should be root-tolerant. The same skill may appear under
installed plugin roots such as `.gemini/config/plugins/superpowers/skills/`,
global skills roots, or workspace `.agents/skills/`; matching should key off
the `skills/<skill>/SKILL.md` suffix rather than one absolute prefix.

This is required for parity: `skill-called superpowers:writing-plans` should
mean the same kind of behavioral evidence for Antigravity as it does for
Claude and Codex.

## Runner diagnostics

Antigravity should fail closed when capture is missing and add clearer
diagnostics for its common failure modes:

- no transcript appeared under the isolated `ANTIGRAVITY_CONFIG_DIR`;
- `agy` wrote a `.antigravitycli` project marker in the workdir, but no matching
  transcript landed in the isolated `.gemini`;
- plugin install succeeded but expected plugin files were missing;
- auth/keyring preflight failed.

The minimum is a clear runner/setup error for failed install or failed auth
preflight, and a clear post-run indeterminate reason for missing Antigravity
transcripts. For Antigravity specifically, an empty capture should be
`indeterminate` even when a scenario has no trace checks; otherwise a pure
artifact scenario could pass without proving Quorum captured the agent at all.
Diffing the host's real `~/.gemini` is not required in v1; absence of isolated
transcripts is enough to fail closed.

## Scenario rollout

Adding `coding-agents/antigravity.yaml` changes `run-all` discovery because
`run-all` enumerates every YAML target. Existing ungated scenarios were written
when only Claude and Codex were runnable by default, and some stories or checks
still carry Claude/Codex-specific assumptions.

The implementation must include a scenario compatibility rollout:

- Add a new Antigravity bootstrap scenario that proves Superpowers installs
  under the isolated `.gemini/config/plugins/superpowers`, produces a non-empty
  Antigravity trace, and satisfies `skill-called` through the normalized
  `Read` predicate.
- Do not use `codex-native-hooks-bootstrap` as the Antigravity smoke; it is
  Codex-gated and checks Codex hook state.
- Either gate not-yet-audited scenarios to the currently supported agents, or
  add an explicit Antigravity allowlist mechanism before `antigravity.yaml`
  joins default `run-all` discovery.
- Opt Antigravity into scenarios only after the story/check wording is portable
  and the scenario has passed a maintainer live run.
- Initial live acceptance should include at least the bootstrap scenario, one
  skill-order scenario, one SDD/subagent-launch scenario, one verification
  scenario, and one worktree scenario.

This rollout does not require every existing scenario to pass in the first
patch. It does require the repository to avoid accidentally treating every
ungated scenario as Antigravity-compatible.

## Gauntlet-Agent HOWTO

Add `coding-agents/antigravity-context/HOWTO.md` and `launch-agent`.

The HOWTO should mirror the Claude/Codex shape:

- Tell the Gauntlet-Agent to launch with exactly `"$QUORUM_LAUNCH_AGENT"`.
- Explain that the launcher cd's into the prepared workdir, sets the isolated
  Antigravity config dir, disables auto-update, and starts the interactive
  `agy` CLI.
- Explain where raw transcripts and logs live:
  `$ANTIGRAVITY_CONFIG_DIR/.gemini/antigravity-cli/brain/**/transcript.jsonl`
  and `$ANTIGRAVITY_CONFIG_DIR/agy.log`.
- Tell the Gauntlet-Agent to trust the transcript/log over the screen when
  checking tool calls.
- Provide a `find` command to locate the newest transcript.
- Provide a `watch_logs(...)` pattern analogous to Claude/Codex if Gauntlet
  supports it for these paths.
- Tell the Gauntlet-Agent how to shut down cleanly after a run.
- Mention that `.antigravitycli/` is Antigravity project metadata and should
  not be treated as work the Coding-Agent intentionally produced.

The HOWTO should name the important Antigravity tool mapping differences:
skills load through `view_file`, subagents may appear as `manage_subagents` or
`invoke_subagent`, and task artifacts are not evidence of native `Task`
behavior until Quorum has real trace semantics for `manage_task`.

## Docs

Update `README.md`:

- Add `antigravity` to the Coding-Agent table with required env
  `SUPERPOWERS_ROOT`.
- Extend the safety section to mention Antigravity uses
  `--dangerously-skip-permissions`.
- Extend the isolation section to mention `ANTIGRAVITY_CONFIG_DIR` and the
  hidden `agy --gemini_dir` dependency.
- Note that Antigravity live evals rely on user/keyring auth and are not
  public-CI safe.
- Note that Antigravity writes `.antigravitycli/` project metadata and Quorum
  excludes it from git-clean checks.
- Add a troubleshooting note:
  check `agy --version`, keyring/auth state, plugin install output, `agy.log`,
  and whether transcript files landed under the isolated config dir.

## Tests

Static tests should cover the parity layer without launching `agy`:

- `normalize_antigravity_logs()` maps real transcript-shaped JSONL into
  canonical Quorum rows.
- Unknown Antigravity tools are preserved.
- Current `agy 1.0.3` transcript fixtures with top-level `tool_calls[]` and
  PascalCase args normalize correctly.
- Alternate/legacy transcript fixtures with nested `PLANNER_RESPONSE.tool_calls[]`
  normalize if present in captured samples.
- `view_file` reads of `.../skills/<skill>/SKILL.md` count for `skill-called`
  through canonical `args.file_path`.
- `view_file` reads with any observed skill marker casing count only when the path
  identifies the requested skill.
- Non-skill `view_file` reads do not count as skill invocations.
- `coding-agents/antigravity.yaml` loads successfully once the normalizer is
  registered.
- Antigravity runner provisioning installs Superpowers from `SUPERPOWERS_ROOT`
  into the isolated config directory. Mock the `agy` subprocess in unit tests;
  do not run live `agy` in CI.
- Runner tests cover install order, `ANTIGRAVITY_CONFIG_DIR` substitution,
  executable `launch-agent`, `AGY_CLI_DISABLE_AUTO_UPDATE=true`, `--gemini_dir`,
  no `--print` in the interactive launcher, `.antigravitycli/` git exclusion,
  missing-transcript indeterminate behavior, and auth preflight failures.
- Scenario rollout tests or checks ensure Antigravity is not accidentally
  included in all ungated scenarios before compatibility has been audited.

Trusted-maintainer live smoke, documented but not part of CI:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers \
uv run quorum run scenarios/antigravity-superpowers-bootstrap --coding-agent antigravity
```

The bootstrap scenario is required acceptance for v1, not an optional follow-up.

## Acceptance

- `uv run quorum run <scenario> --coding-agent antigravity` is a valid target.
- Antigravity installs Superpowers from local `SUPERPOWERS_ROOT`, matching
  Claude/Codex local-checkout parity.
- The run uses an isolated per-run Antigravity config tree.
- Antigravity transcripts are captured into
  `coding-agent-tool-calls.jsonl`.
- Antigravity skill reads satisfy the same `skill-called` and ordering checks
  used by Claude and Codex.
- Unknown Antigravity tools stay visible in normalized traces.
- `.antigravitycli/` project metadata does not break git cleanliness checks.
- Missing transcripts, failed plugin install, failed auth preflight, or failed
  isolation produce clear non-passing diagnostics.
- Static tests cover config loading, normalizer behavior, skill predicate
  parity, runner provisioning, auth diagnostics, git metadata exclusion, and
  setup/install behavior.
- The repository has an Antigravity scenario rollout plan: a bootstrap scenario,
  a small representative live matrix, and no accidental default sweep across
  unaudited scenarios.
- README documents the target, safety model, hidden `--gemini_dir` dependency,
  and live-smoke procedure.
