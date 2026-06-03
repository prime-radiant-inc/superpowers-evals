# Kimi Quorum Coding-Agent Target - design specification

**Status:** Specification. Ready for Drew review. Not yet implemented.
**Date:** 2026-06-03
**Context:** This is a fresh-from-zero design for Kimi Code as a first-class
Quorum Coding-Agent target. Existing Kimi files in this repository are useful
context, but this spec intentionally does not preserve their local
`~/.kimi-code` auth coupling.

---

## Goal

Add `kimi` as a first-class Quorum Coding-Agent target that can run the same
Superpowers behavioral scenarios as Claude, Codex, Antigravity, and Gemini.

The Kimi harness must optimize for reproducibility and isolation:

- no reads, copies, or symlinks from the user's real `~/.kimi-code`;
- no user plugins, user skills, history, OAuth state, or sessions;
- auth/model config comes from explicit environment variables;
- Superpowers is installed from the local `SUPERPOWERS_ROOT` checkout;
- harness failures are diagnosed as setup/capture problems instead of
  masquerading as scenario failures.

Expected maintainer command shape:

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
export KIMI_MODEL_API_KEY=...
uv run quorum run scenarios/kimi-superpowers-bootstrap --coding-agent kimi
```

## Non-goals

- Reusing local `~/.kimi-code` config, credentials, OAuth state, plugins,
  sessions, history, or skills.
- Using `KIMI_API_KEY` as plain shell auth. Kimi Code does not treat that as a
  complete CLI auth/model configuration path.
- Writing provider secrets into `config.toml`.
- Using `--skills-dir` as a runtime install strategy or fallback.
- Running Kimi live evals in public CI.
- Kimi cost estimation in v1. Token counts are captured, but pricing remains
  unpriced until Kimi pricing/model mapping is separately verified.
- A generic plugin-source abstraction for every Coding-Agent.

## Target config

Add or update `coding-agents/kimi.yaml`:

```yaml
name: kimi
binary: kimi
agent_config_env: KIMI_CODE_HOME
session_log_dir: "${KIMI_CODE_HOME}/sessions"
session_log_glob: "**/wire.jsonl"
normalizer: kimi
required_env:
  - SUPERPOWERS_ROOT
  - KIMI_MODEL_API_KEY
max_time: 10m
```

`KIMI_MODEL_NAME` is not required from the host because Quorum supplies a
default. Maintainers may override it explicitly.

Do not add `max_concurrency` in v1. Initial sweeps should run operationally
with `--jobs 1`; a concurrency cap can be added only after Kimi shows a
backend-level parallel-run constraint.

## Auth and isolation

Each run gets a fresh Kimi home under the Quorum run directory:

```text
<run>/coding-agent-config/
```

Runtime paths:

```bash
KIMI_CODE_HOME=<run>/coding-agent-config
HOME=<run>/coding-agent-config/home
KIMI_CODE_CACHE_DIR=<run>/coding-agent-config/cache
```

Quorum must not read, copy, or symlink anything from `~/.kimi-code`.

Kimi auth/model setup uses Kimi Code's temporary provider environment overlay.
Host-required env:

```bash
KIMI_MODEL_API_KEY
```

Runner-supplied defaults, overridable by host env:

```bash
KIMI_MODEL_NAME=kimi-for-coding
KIMI_MODEL_PROVIDER_TYPE=kimi
KIMI_MODEL_BASE_URL=https://api.kimi.com/coding/v1
KIMI_MODEL_MAX_CONTEXT_SIZE=262144
KIMI_MODEL_CAPABILITIES=thinking,image_in,video_in,tool_use
KIMI_MODEL_DEFAULT_THINKING=true
KIMI_DISABLE_TELEMETRY=1
KIMI_DISABLE_CRON=1
KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT=false
```

If Kimi reports `No model configured`, the env overlay did not take effect and
setup must fail. There is no v1 fallback to generated provider `config.toml`.

## Runtime env file

Gauntlet/tmux does not reliably propagate arbitrary env vars into the QA
agent's shell. Quorum should therefore write a chmod-0600 runtime env file
inside `<run>/coding-agent-config` containing the Kimi runtime env values.

The generated launcher contains only the env-file path, not secret values. It
sources the file, deletes it, then execs Kimi. Use a shell `trap` so the file is
also removed on launcher failure.

Secret values must not appear in:

- `gauntlet-agent/context/HOWTO.md`;
- `gauntlet-agent/context/launch-agent`;
- `verdict.json`;
- `coding-agent-tool-calls.jsonl`;
- `coding-agent-token-usage.json`;
- Gauntlet `result.json` / `run.jsonl`;
- deterministic check output;
- setup/capture diagnostics.

Run directories are still sensitive live-eval artifacts because raw wire logs
and model outputs may contain user/test content.

## Auth preflight

Kimi gets an Antigravity/Gemini-style model-invoking preflight, cached once per
Quorum process/batch.

The preflight uses:

- throwaway `KIMI_CODE_HOME`;
- throwaway `HOME`;
- throwaway `KIMI_CODE_CACHE_DIR`;
- throwaway cwd;
- the same `KIMI_MODEL_*` env contract as real runs.

It runs:

```bash
kimi -p "Reply with EXACTLY OK." --output-format stream-json
```

Pass criteria:

- process exits 0;
- assistant response normalizes to `OK` after trimming whitespace and trailing
  punctuation;
- the throwaway home contains `session_index.jsonl`;
- the throwaway home contains at least one `sessions/**/wire.jsonl`;
- `session_index.jsonl` records a `workDir` matching the throwaway cwd.

The preflight must never use the real run's `KIMI_CODE_HOME`; otherwise it can
pollute Quorum's capture snapshot.

Preflight failure is setup-stage `indeterminate`. Diagnose at least:

- missing `KIMI_MODEL_API_KEY`;
- missing `kimi` binary;
- unsupported env channel / `No model configured`;
- 401 / auth failure;
- rate-limit or quota failure;
- timeout/network failure;
- any transcript/log written into the real run home.

## Superpowers install

Kimi gets Superpowers through isolated plugin metadata, not `--skills-dir`.

Quorum writes exactly one enabled plugin record:

```text
$KIMI_CODE_HOME/plugins/installed.json
```

Shape:

```json
{
  "version": 1,
  "plugins": [
    {
      "id": "superpowers",
      "root": "<SUPERPOWERS_ROOT>",
      "source": "local-path",
      "enabled": true,
      "installedAt": "<iso8601>",
      "updatedAt": "<iso8601>",
      "originalSource": "<SUPERPOWERS_ROOT>"
    }
  ]
}
```

Use `source: "local-path"`. Earlier local artifacts used `local`, but the fresh
spec should follow Kimi's current source naming.

Validate `SUPERPOWERS_ROOT` before launch:

- path is absolute or resolvable to an absolute path;
- `.kimi-plugin/plugin.json` exists and parses;
- `skills/using-superpowers/SKILL.md` exists;
- `skills/brainstorming/SKILL.md` exists;
- manifest `name` is `superpowers`;
- manifest `skills` points at `./skills/`;
- manifest `sessionStart.skill` is `using-superpowers`;
- manifest `skillInstructions` is non-empty and includes Kimi tool mappings;
- manifest skill path resolves inside `SUPERPOWERS_ROOT`.

Do not run `/plugins install "$SUPERPOWERS_ROOT"` for Quorum provisioning. Kimi
copies local installs into `plugins/managed/<id>`, which would test a copied
snapshot instead of the local checkout under test.

Do not use `--skills-dir`. It only proves Kimi can discover skill files. It
does not exercise plugin identity, `sessionStart.skill`, or
`skillInstructions`, which are the surfaces this harness must evaluate.

## Launcher and HOWTO

Kimi follows the same one-command launcher model as other Quorum targets.

The generated launcher should:

1. `cd` into the resolved Quorum launch cwd.
2. Set run-local `KIMI_CODE_HOME`, `HOME`, and `KIMI_CODE_CACHE_DIR`.
3. Source the runtime env file.
4. Delete the runtime env file before `exec`.
5. Start interactive Kimi:

```bash
kimi --yolo "$@"
```

The launcher must not:

- contain literal API keys;
- use `--prompt` for normal interactive evals;
- use `--skills-dir`;
- use `--auto`;
- rely on Gauntlet/tmux inheriting secrets.

The HOWTO should tell the Gauntlet-Agent to run exactly:

```bash
"$QUORUM_LAUNCH_AGENT"
```

It should also point to the ground-truth logs:

```text
$KIMI_CODE_HOME/session_index.jsonl
$KIMI_CODE_HOME/sessions/**/agents/main/wire.jsonl
```

As with Claude and Antigravity, the HOWTO should emphasize log watching over
screen polling.

## Capture and normalization

Kimi capture uses:

```yaml
session_log_dir: "${KIMI_CODE_HOME}/sessions"
session_log_glob: "**/wire.jsonl"
normalizer: kimi
```

Quorum snapshots the isolated session-log directory before launching Gauntlet.
After the run, it captures new `wire.jsonl` files and filters them through
`session_index.jsonl`.

Filtering rule:

1. For each new `wire.jsonl`, find its enclosing Kimi `sessionDir`.
2. Read `$KIMI_CODE_HOME/session_index.jsonl`.
3. Keep the log only if the matching entry has
   `realpath(workDir) == realpath(launch_cwd)`.

If sessions exist but every `workDir` mismatches `launch_cwd`, report a clear
QA-agent-misconfigured diagnostic: Kimi was likely launched from the wrong cwd
or the generated launcher was bypassed.

Normalizer rule:

- Parse JSONL rows with
  `type == "context.append_loop_event"` and `event.type == "tool.call"`.
- Emit Quorum rows:

```json
{"tool": "<name>", "args": {}, "source": "native"}
```

- Preserve Kimi tool names.
- Mark `Bash` as shell.
- Treat Kimi-native tools as native.
- Canonicalize native `Skill` args so `brainstorming` becomes
  `superpowers:brainstorming`.

The existing shared `skill-*` checks should work unchanged because they already
recognize native `Skill` rows and fallback `SKILL.md` reads.

## Capture fail-closed behavior

Kimi should fail closed like Antigravity:

- no Kimi `wire.jsonl` after capture -> `indeterminate`, stage `capture`;
- `session_index.jsonl` exists but no session matches launch cwd ->
  `indeterminate`, with a clear cwd/launcher diagnostic;
- matching `wire.jsonl` files normalize to zero tool-call rows ->
  `indeterminate`, stage `capture`;
- plugin metadata exists but raw wire log lacks `plugin_session_start` ->
  explicit setup/product-boundary diagnostic, not a vague trace-check failure.

These diagnostics must fire even for scenarios without trace checks, so harness
capture failures cannot pass file-only scenarios accidentally.

## Token usage

Kimi v1 captures token counts from `usage.record` rows in `wire.jsonl`, but
does not estimate cost.

Mapping:

- `usage.inputOther` -> `total_input`;
- `usage.inputCacheRead` -> `total_cache_read`;
- `usage.inputCacheCreation` -> `total_cache_create`;
- `usage.output` -> `total_output`;
- `model` -> model bucket key;
- `usageScope == "turn"` -> assistant turn count;
- numeric millisecond `time` -> `first_ts`, `last_ts`, and `duration_ms`.

When usage records are present, Quorum writes
`coding-agent-token-usage.json`. Top-level `est_cost_usd` and every Kimi model's
`est_cost_usd` must be `null`, and the output should set
`has_unpriced_model: true`, until Kimi pricing/model mapping is verified.

Token capture remains measurement-only and never affects verdicts.

## Behavioral proof

Plugin metadata is not proof by itself.

The bootstrap scenario must prove:

1. raw `wire.jsonl` contains `plugin_session_start` for
   `plugin="superpowers"` and `skill="using-superpowers"`;
2. normalized trace contains `superpowers:brainstorming`;
3. brainstorming happens before implementation tools such as `Edit` or `Write`;
4. Kimi ran from the isolated run-local `KIMI_CODE_HOME`.

`--skills-dir` passing would only prove skill discovery. It is not evidence of
Superpowers plugin bootstrap.

## Tests

Unit/static tests should cover:

- `coding-agents/kimi.yaml` loads and resolves session log paths.
- Required env includes `SUPERPOWERS_ROOT` and `KIMI_MODEL_API_KEY`.
- Runner creates isolated `KIMI_CODE_HOME`, `HOME`, and cache directories.
- Runner never reads, copies, or symlinks host `~/.kimi-code`.
- Runtime env file permissions are `0600`.
- Runtime env file contains the expected Kimi env values in tests with a fake
  sentinel key.
- The fake key does not appear in launcher, HOWTO, verdict, normalized traces,
  or diagnostics.
- Launcher substitutions leave no unresolved `$QUORUM_AGENT_CWD` or
  `$KIMI_CODE_HOME` placeholders.
- Launcher uses `kimi --yolo`.
- Launcher does not use `--prompt`, `--auto`, or `--skills-dir`.
- Auth preflight uses a throwaway Kimi home and never writes into the real run
  home.
- Plugin metadata writes one enabled `superpowers` plugin with
  `source: "local-path"`.
- Manifest validation rejects missing files, wrong `sessionStart.skill`, and
  skill paths escaping the plugin root.
- Capture filters logs by `session_index.jsonl` `workDir`.
- Capture handles no logs, cwd mismatch, and zero normalized rows as explicit
  indeterminate verdicts.
- Normalizer parses Kimi `tool.call` rows and canonicalizes bare Skill names.
- Token parser sums Kimi `usage.record` rows and leaves cost unpriced.
- `kimi-plugin-installed` (or its replacement) validates the new
  `source: "local-path"` metadata shape.

Static verification remains:

```bash
uv run ruff check
uv run ty check
uv run quorum check
uv run pytest
```

## Live rollout

First live acceptance is only:

```bash
uv run quorum run scenarios/kimi-superpowers-bootstrap --coding-agent kimi
```

It must pass with a non-empty normalized trace containing
`superpowers:brainstorming` before `Edit` or `Write`.

After that, run a small curated subset before broad sweeps:

- `triggering-writing-plans`;
- `triggering-test-driven-development`;
- `explicit-skill-request-sdd`;
- `claim-without-verification-naive`;
- one worktree scenario.

Initial Kimi sweeps should use:

```bash
uv run quorum run-all --coding-agents kimi --jobs 1
```

Triage failures as:

- `harness-fail` - setup, auth, plugin, capture, normalization, or secret
  handling broke;
- `scenario-port-needed` - scenario assumes another agent's tools or UX;
- `product-fail` - Kimi plus Superpowers behavior failed.

Do not add scenario allowlists merely because Kimi fails a broad scenario. Add
`# coding-agents:` restrictions only when a scenario is genuinely inapplicable.

## Docs and security

README should document:

- Kimi trusted-maintainer live eval setup;
- required env vars;
- isolated `KIMI_CODE_HOME`;
- runtime env file behavior;
- plugin metadata install;
- troubleshooting with `session_index.jsonl`, `wire.jsonl`, and
  `coding-agent-tool-calls.jsonl`.

SECURITY should mention:

- Kimi live runs use `kimi --yolo`;
- Kimi run artifacts include raw `wire.jsonl` model/tool logs;
- `.kimi-code/` is sensitive local agent state;
- public CI must not run live Kimi evals.

## Acceptance criteria

- `uv run quorum run ... --coding-agent kimi` treats Kimi as a known target.
- Kimi runs require `SUPERPOWERS_ROOT` and `KIMI_MODEL_API_KEY`.
- Kimi runs do not touch host `~/.kimi-code`.
- Kimi preflight proves clean-home auth/model startup before Gauntlet.
- Runtime launcher starts interactive Kimi from the resolved launch cwd with
  `--yolo`.
- Local Superpowers plugin is the only enabled Kimi plugin in isolated
  `installed.json`.
- The raw Kimi wire log shows Superpowers `plugin_session_start`.
- Normalized trace shows `superpowers:brainstorming` before implementation
  tools in the bootstrap scenario.
- Missing logs, cwd mismatch, and zero-row normalization produce explicit
  indeterminate diagnostics.
- Kimi token counts are captured when `usage.record` rows are present; cost is
  unpriced in v1.
- No real or fake API key leaks into launcher, HOWTO, verdict, normalized
  results, or diagnostic text.
- Broad Kimi sweeps remain trusted-maintainer only.
