# Superpowers Evals

Behavioral eval lab for [superpowers](https://github.com/obra/superpowers).
**Quorum** drives real coding-agent CLIs (Claude, Codex, Antigravity, Gemini,
Kimi, OpenCode, Pi, and Copilot) through a Gauntlet QA agent and grades them
against scenario acceptance criteria plus deterministic post-checks.

Code, CLI, paths, and inline prose all use lowercase `quorum`; the capitalized
form `Quorum` appears in headings and the actor table.

This is not a generic benchmark suite. It is an eval lab for workflow
compliance: skill triggering, worktree behavior, subagent coordination,
verification reflexes, review quality, and cost-shaping patterns.

## Safety Model

quorum has two very different execution modes:

- **Static/unit checks** are safe for public CI. They run `ruff`, `ty`, and
  `pytest`. They do not call model APIs and do not launch agent CLIs.
- **Live evals** are trusted-maintainer operations. They launch Claude Code,
  Codex CLI, Antigravity CLI, Gemini CLI, Kimi Code, OpenCode CLI, Pi CLI, or
  Copilot CLI in permissive modes and collect raw transcripts, tool calls,
  filesystem state, and session logs.

Public CI must stay on the static/unit side of that line. Never add API keys,
live `quorum run …` invocations, or dangerous-mode agent launches to public
CI.

## Live Eval Risk

Live evals run the Coding-Agent under test with broad execution power:

- Claude uses `--dangerously-skip-permissions`.
- Codex uses `--dangerously-bypass-approvals-and-sandbox`.
- Antigravity uses `--dangerously-skip-permissions` and relies on local
  browser/keyring auth for `agy`.
- Gemini uses `--skip-trust --approval-mode=yolo` and API-key auth.
- Kimi uses `--yolo`.
- OpenCode uses `--dangerously-skip-permissions`.
- Pi uses explicit tool allowlists and API-key auth in a run-local config dir.
- Copilot uses `--allow-all`.

quorum seeds a fresh per-run agent-config dir (`CLAUDE_CONFIG_DIR` for
Claude, `CODEX_HOME` for Codex, `ANTIGRAVITY_CONFIG_DIR` for Antigravity,
`GEMINI_CLI_HOME` for Gemini, `KIMI_CODE_HOME` for Kimi,
`OPENCODE_QUORUM_HOME` plus isolated XDG dirs for OpenCode,
`PI_CODING_AGENT_DIR` for Pi, and `COPILOT_HOME` for Copilot) so the
Coding-Agent never sees the host's real
`~/.claude`, `~/.codex`, `~/.gemini`, `~/.kimi-code`, `~/.pi`,
`~/.copilot`, or OpenCode state, installed plugins, or prior sessions. Copilot
stages the local Superpowers plugin under the isolated home, uses an
allowlisted outer environment, and writes a secret-bearing chmod-0600
`.copilot-env` inside the run dir. That narrows the blast radius but is not a
sandbox. OpenCode and Copilot launchers additionally use allowlisted
environments, but live Coding-Agents still run with broad filesystem and
command execution power.

Run live evals only from a trusted local environment:

- Export only the API key needed for the selected Coding-Agent.
- Avoid running with broad production or personal secrets in the environment.
- Treat `results/`, raw session logs, session-state/tool-call artifacts, and
  Gauntlet-Agent inputs as
  sensitive.
- Do not commit or paste raw run artifacts without checking them first.

## Quick Start

Install:

```bash
uv sync --extra dev
```

Run one scenario:

```bash
uv run quorum run scenarios/triggering-writing-plans --coding-agent claude
```

Agent names are `claude`, `codex`, `antigravity`, `gemini`, `kimi`,
`opencode`, `pi`, and `copilot`; not every scenario is valid for every agent.

List scenarios:

```bash
uv run quorum list
```

Scaffold and validate a new scenario:

```bash
uv run quorum new my-new-scenario
uv run quorum check my-new-scenario
```

`quorum check` with no arguments validates every scenario.

Run the full matrix:

```bash
uv run quorum run-all --coding-agents claude,codex --jobs 2
```

`run-all` runs every scenario against every Coding-Agent, filtered by each
scenario's `# coding-agents:` directive. View the resulting matrix with
`uv run quorum show <batch-id>`.

Trusted-maintainer Antigravity sweep:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers uv run quorum run-all --coding-agents antigravity --jobs 1
```

Do not wire Antigravity live evals to public CI; they launch `agy` with
`--dangerously-skip-permissions` and depend on local browser/keyring auth.

Trusted-maintainer Gemini smoke:

```bash
export GEMINI_API_KEY=...
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
uv run quorum run scenarios/gemini-superpowers-bootstrap --coding-agent gemini
uv run quorum show <run-dir>
```

Do not wire Gemini live evals to public CI; they launch `gemini` with
`--approval-mode=yolo` and preserve secret-bearing run artifacts.

Trusted-maintainer Kimi smoke:

```bash
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
export KIMI_MODEL_API_KEY=...
uv run quorum run scenarios/kimi-superpowers-bootstrap --coding-agent kimi
```

For a Kimi-only sweep:

```bash
uv run quorum run-all --coding-agents kimi --jobs 1
```

Kimi runs use a fresh per-run `KIMI_CODE_HOME` and do not read or symlink local
`~/.kimi-code`. Auth/model config comes from `KIMI_MODEL_API_KEY` plus
Quorum's default Kimi provider env. `KIMI_MODEL_NAME` may be overridden; other
host `KIMI_MODEL_*` overrides are rejected in v1 for reproducibility.

Do not wire Kimi live evals to public CI. They launch `kimi --yolo`, write raw
`wire.jsonl` model/tool logs, and should not be run against untrusted PR
scenarios until Kimi tool-subprocess env scrubbing has been verified.

Trusted-maintainer OpenCode bootstrap smoke:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers uv run quorum run scenarios/opencode-superpowers-bootstrap --coding-agent opencode
```

Do not wire OpenCode live evals to public CI; they launch `opencode` with
`--dangerously-skip-permissions` and depend on local provider credentials.

Trusted-maintainer Pi bootstrap smoke:

```bash
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
export PI_PROVIDER=openai
export PI_MODEL=gpt-5.5
export PI_API_KEY=...
uv run quorum run scenarios/pi-superpowers-bootstrap --coding-agent pi
uv run quorum show <run-dir>
```

Do not wire Pi live evals to public CI; they launch `pi` with broad tool
allowlists and preserve secret-bearing run artifacts.

Trusted-maintainer Copilot bootstrap smoke:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers uv run quorum run scenarios/copilot-superpowers-bootstrap --coding-agent copilot
```

Do not wire Copilot live evals to public CI; they launch `copilot` with
`--allow-all` and preserve secret-bearing run artifacts.

## Canonical Actors

Keep the actors straight; confusing them is the most common triage error.
These names are used everywhere — docs, CLI output, code, filenames, commit
messages.

| Actor | What it is | Where it lives / its files |
|---|---|---|
| **Gauntlet** | General-purpose QA framework; the `gauntlet` CLI. A black-box tester. | repo `~/Code/prime/gauntlet`; on `PATH` as `gauntlet` |
| **Gauntlet-Agent** | The LLM *inside* Gauntlet that drives the Coding-Agent and self-grades against the story's ACs. | model e.g. `claude-sonnet-4-6`; event stream → `<run>/gauntlet-agent/results/<runId>/run.jsonl`; verdict → `result.{json,md}` |
| **Coding-Agent** | The agent under test — the SUT. Instances: **Claude**, **Codex**, **Antigravity**, **Gemini**, **Kimi**, **OpenCode**, **Pi**, **Copilot**. | session log → `<run>/coding-agent-config/…`; the files it writes → `<run>/coding-agent-workdir/` |
| **Quorum** | The Python wrapper. Owns setup, Coding-Agent adaptation, deterministic checks, and the final verdict. | repo `superpowers-evals/quorum/`; `<run>/verdict.json` |

A run involves **two** LLMs — the **Gauntlet-Agent** (QA tester) and the
**Coding-Agent** (subject). Separate models, separate logs, separate token
costs.

## Scenario Anatomy

A scenario is a directory under `scenarios/<name>/`:

```text
story.md    Gauntlet story — the QA agent's brief + acceptance criteria
setup.sh    builds the fixture workdir (runs before the Coding-Agent)
checks.sh   deterministic checks — pre() + post() bash functions
```

`story.md` carries YAML frontmatter (`id`, `title`) and an
`## Acceptance Criteria` section. Write criteria to demand log evidence
(e.g. "a `Skill` invocation naming `superpowers:writing-plans` appears in the
Coding-Agent's session log") so the Gauntlet-Agent must consult the log, not
just the screen.

Optional frontmatter field `quorum_max_time` overrides the per-coding-agent
`max_time` for this scenario only (strict override — raises *or* lowers it).
Use it for slow scenarios that need a longer budget than the default:

```yaml
---
id: my-slow-sdd
title: ...
quorum_max_time: 90m   # this scenario gets 90 minutes; others keep the agent default
---
```

The value is a Gauntlet duration string (`90m`, `600s`, or bare seconds like
`1800`). It is a quorum-only field — gauntlet does not read it; a direct
`gauntlet run --max-time …` is unaffected.

### `checks.sh` Format

`checks.sh` is a bash script containing exactly two functions — `pre()` and
`post()` — and nothing else at the top level:

```bash
# coding-agents: claude,codex   ← optional; restricts which agents run this scenario
pre() {
    git-repo
    git-branch main
}

post() {
    file-exists "docs/plan.md"
    skill-called superpowers:writing-plans
}
```

`pre()` runs after `setup.sh`, before the Coding-Agent starts. `post()` runs
after the Coding-Agent's session is captured. The optional
`# coding-agents: <csv>` magic comment restricts which Coding-Agents the
scenario is valid for; omit it to allow all agents.

Scripts must have **no exec bit** and contain only function definitions.
Invoke check tools by name — they are on `PATH` via `bin/`.

### Check Vocabulary (`bin/`)

Every tool emits one JSON record per invocation. A non-zero exit means the
check failed; the record carries a `detail` string explaining why.

**Artifact surface** — the filesystem the Coding-Agent produced:
- `file-exists <glob>` — a path matching the glob exists.
- `file-contains <path> <regex>` — the file exists and matches the regex.
- `command-succeeds <cmd>` — the command, run in the Coding-Agent's workdir, exits 0. Use for project build/test commands (`go test ./…`, `npm test`), not as a substitute for `file-contains`.

**Git surface** — git state the Coding-Agent shaped:
- `git-repo` — the workdir is a git work tree.
- `git-branch <name>` — current branch equals name; use `detached` for detached HEAD.
- `git-clean` — the working tree has no uncommitted changes.
- `git-count worktrees|commits <op> <n>` — the count satisfies the comparison (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`).

**Trace surface** — the Coding-Agent's normalized tool-call log (`coding-agent-tool-calls.jsonl`):
- `tool-called <tool>` — the tool appears in the trace at least once.
- `tool-count <tool> <op> <n>` — the call count satisfies the comparison.
- `tool-before <a> <b>` — tool `a` was called before tool `b`.
- `tool-arg-match <tool> <jq>` — at least one call to `tool` has args matching the jq filter.
- `tool-match-before-tool-match <tool-a> <jq-a> <tool-b> <jq-b>` — a matching call to `a` precedes a matching call to `b`.
- `skill-called <skill>` — a `Skill` invocation names the given skill.
- `skill-not-called <skill>` — no `Skill` invocation names the given skill.
- `skill-before-tool <skill> <tool>` — the skill was invoked before the tool.
- `skill-before-tool-match <skill> <tool> <jq>` — the skill was invoked before a matching call to `tool`.

**Negation:**
- `not <check> [args…]` — runs the inner check without emitting a record, inverts the result, and emits one negated record. Always use `not` rather than bash's bare `!`.

The shared `_record` helper (sourced by every tool) handles record emission and
an `ERR` trap so a crashing tool never silently drops out of the verdict.

## Verdict

quorum produces a **three-valued verdict** — `pass | fail | indeterminate`:

- `pass` — Gauntlet-Agent passed **and** every post-check passed.
- `fail` — Gauntlet-Agent failed, or a post-check failed.
- `indeterminate` — a pre-check failed (invalid fixture), Gauntlet-Agent returned `investigate`, the capture was empty while a trace check was present, or quorum itself errored. An `indeterminate` run is not a finding — it is a signal that the run did not execute cleanly.

The structured `verdict.json` (schema v1) contains:

- `gauntlet` layer — `status`, `summary`, `reasoning`, `run_id`.
- `checks` layer — an array of records from `pre()` and `post()`, each with `check`, `args`, `negated`, `passed`, `detail`, `phase`.
- `final` — the composed `pass | fail | indeterminate`.
- `final_reason` — a human-readable explanation of the verdict.
- `error` — present if quorum itself threw; includes `stage` and `message`.

**Exit codes:** 0 = pass, 1 = fail, 2 = indeterminate.

## Run Directory Layout

Each run produces one directory under `results/`, with every entry
prefixed by the actor it belongs to:

```text
results/<scenario>-<coding-agent>-<timestamp>/
├── verdict.json                     the composed result — the front door
├── gauntlet-agent/                  the Gauntlet-Agent's evidence
│   └── results/<runId>/
│       ├── result.{json,md}         the Gauntlet-Agent's verdict
│       ├── run.jsonl                the Gauntlet-Agent's event stream
│       ├── inputs/story.md
│       └── captures/
├── coding-agent-workdir/            the Coding-Agent's file output
├── coding-agent-config/             the Coding-Agent's isolated config home
├── coding-agent-tool-calls.jsonl    the Coding-Agent's normalized trace
└── coding-agent-token-usage.json    the Coding-Agent's token cost
```

`results/` is gitignored because run artifacts can contain sensitive
transcripts.

## Coding-Agents

A Coding-Agent is one agent CLI under test. Its config is
`coding-agents/<name>.yaml`; its companion HOWTO,
`coding-agents/<name>-context/HOWTO.md`, is prose the Gauntlet-Agent reads to
learn how to launch and observe that CLI. Claude additionally has a home
skeleton at `coding-agents/claude-home-skeleton/` that gets copied into the
per-run `CLAUDE_CONFIG_DIR` (Codex provisions its home fresh per run via
`codex login --with-api-key`; Antigravity and Gemini provision isolated
`.gemini` state fresh per run; Kimi provisions an isolated `KIMI_CODE_HOME`;
OpenCode stages the local Superpowers plugin and skills into isolated XDG
dirs; Pi provisions run-local auth and settings; Copilot stages the local
Superpowers plugin into an isolated `COPILOT_HOME` and writes a private
`.copilot-env`). All authored once per agent and shared across scenarios.

| Coding-Agent | CLI | Required environment |
| --- | --- | --- |
| `claude` | Claude Code | `ANTHROPIC_API_KEY`, `SUPERPOWERS_ROOT` |
| `codex` | Codex CLI | `OPENAI_API_KEY`, `SUPERPOWERS_ROOT` |
| `antigravity` | Google Antigravity CLI (`agy`) | `SUPERPOWERS_ROOT` |
| `gemini` | Gemini CLI (`gemini`) | `GEMINI_API_KEY`, `SUPERPOWERS_ROOT` |
| `kimi` | Kimi Code | `KIMI_MODEL_API_KEY`, `SUPERPOWERS_ROOT` |
| `opencode` | OpenCode CLI | `SUPERPOWERS_ROOT`, provider credentials for the selected OpenCode model |
| `pi` | Pi CLI (`pi`) | `SUPERPOWERS_ROOT`, `PI_PROVIDER`, `PI_MODEL`, `PI_API_KEY` |
| `copilot` | GitHub Copilot CLI (`copilot`) | `SUPERPOWERS_ROOT`, plus `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, GitHub CLI auth, or `COPILOT_PROVIDER_BASE_URL` |

For `PI_PROVIDER=azure-openai-responses`, set either `AZURE_OPENAI_BASE_URL`
or `AZURE_OPENAI_RESOURCE_NAME`; quorum also forwards optional
`AZURE_OPENAI_API_VERSION` and `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`.

When this repo is checked out as `superpowers/evals`, quorum defaults
`SUPERPOWERS_ROOT` to the parent `superpowers` checkout. In a standalone
`superpowers-evals` clone, set it explicitly:

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
```

Use a different `SUPERPOWERS_ROOT` when running RED/GREEN comparisons against
modified superpowers skill text.

### Gemini

`coding-agents/gemini.yaml` launches Gemini CLI as `gemini`. quorum creates an
isolated per-run `GEMINI_CLI_HOME` under `<run>/coding-agent-config`, writes a
chmod-0600 runtime env file containing `GEMINI_API_KEY`, seeds API-key auth in
`.gemini/settings.json`, and links Superpowers from local `SUPERPOWERS_ROOT`
with:

```bash
gemini extensions link "$SUPERPOWERS_ROOT" --consent
```

The generated launcher starts interactive Gemini from the scenario workdir with:

```bash
GEMINI_CLI_HOME="$GEMINI_CLI_HOME" \
GEMINI_DEFAULT_AUTH_TYPE=gemini-api-key \
GEMINI_CLI_TRUST_WORKSPACE=true \
gemini --skip-trust --approval-mode=yolo
```

Gemini run artifacts are secret-bearing live-eval artifacts because the
isolated config dir contains the per-run `.gemini-env` file. Do not commit,
paste, or publish Gemini run directories without scrubbing them.

Provisioning verifies that Gemini linked and enabled Superpowers by checking:

```text
<run>/coding-agent-config/.gemini/extensions/superpowers/.gemini-extension-install.json
<run>/coding-agent-config/.gemini/extensions/extension-enablement.json
<run>/coding-agent-config/.gemini/extension_integrity.json
```

Those files prove the extension was linked. They do not prove Gemini honored
Superpowers behavior. Behavioral evidence comes from normalized transcript rows
in `<run>/coding-agent-tool-calls.jsonl` and from raw Gemini transcripts at:

```text
<run>/coding-agent-config/.gemini/tmp/**/chats/**/*.json*
```

Live smoke:

```bash
export GEMINI_API_KEY=...
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
uv run quorum run scenarios/gemini-superpowers-bootstrap --coding-agent gemini
uv run quorum show <run-dir>
```

### Antigravity

`coding-agents/antigravity.yaml` launches Google Antigravity CLI as `agy`.
It requires `SUPERPOWERS_ROOT` because quorum installs the local Superpowers
plugin into each run's isolated Antigravity config. The runner creates a
per-run `ANTIGRAVITY_CONFIG_DIR` under the run directory and the generated
launcher starts interactive `agy` from the scenario workdir with:

```bash
ANTIGRAVITY_CONFIG_DIR="$ANTIGRAVITY_CONFIG_DIR" \
AGY_CLI_DISABLE_AUTO_UPDATE=true \
agy \
  --gemini_dir="$ANTIGRAVITY_CONFIG_DIR/.gemini" \
  --dangerously-skip-permissions \
  --log-file "$ANTIGRAVITY_CONFIG_DIR/agy.log"
```

`--gemini_dir` is a hidden Antigravity CLI compatibility dependency; keep it
inside the runner/launcher path, not in scenarios. `AGY_CLI_DISABLE_AUTO_UPDATE`
keeps runs from mutating themselves mid-eval. Before launch, quorum runs an
auth/isolation preflight using a throwaway `--gemini_dir`, then installs the
plugin into the real per-run config with:

```bash
agy --gemini_dir="$ANTIGRAVITY_CONFIG_DIR/.gemini" plugin install "$SUPERPOWERS_ROOT"
```

Antigravity auth is local browser/keyring state owned by the maintainer running
the eval. It is not an environment-only CI credential model, and Antigravity
live evals must not be added to public CI.

Provisioning verifies that `plugin.json`, `hooks.json`, and
`skills/using-superpowers/SKILL.md` exist under:

```text
<run>/coding-agent-config/.gemini/config/plugins/superpowers/
```

Those files prove the plugin was installed. They do not prove hook or skill
behavior. Behavioral evidence comes from normalized transcript rows in
`<run>/coding-agent-tool-calls.jsonl` and from raw Antigravity transcripts at:

```text
<run>/coding-agent-config/.gemini/antigravity-cli/brain/**/transcript.jsonl
```

The Antigravity CLI lifecycle/debug log is:

```text
<run>/coding-agent-config/agy.log
```

Antigravity may also write `.antigravitycli/` project metadata in the launch
worktree. quorum adds that path to the local repo exclude file
(`.git/info/exclude`) when the run starts; it is runtime metadata, not a
scenario artifact to commit.

### Kimi

`coding-agents/kimi.yaml` launches Kimi Code as `kimi`. It requires
`SUPERPOWERS_ROOT` because quorum installs the local Superpowers plugin into
each run's isolated Kimi config. Kimi auth/model setup comes from
`KIMI_MODEL_API_KEY` plus quorum's default Kimi provider environment, with
`KIMI_MODEL_NAME` available as the only host `KIMI_MODEL_*` override in v1.

The runner creates a fresh per-run `KIMI_CODE_HOME` under the run directory and
does not read or symlink the host's `~/.kimi-code`. Before launch, quorum writes
`plugins/installed.json` with a single enabled Superpowers plugin whose
`source` is `local-path` and whose root realpath matches `SUPERPOWERS_ROOT`.
The runtime must not contain a copied `plugins/managed/superpowers` plugin.

Kimi launches with:

```bash
kimi --yolo
```

Kimi run artifacts are sensitive. In addition to the normalized
`<run>/coding-agent-tool-calls.jsonl`, raw Kimi wire logs may appear at:

```text
<run>/coding-agent-config/**/wire.jsonl
```

Those logs can contain model outputs, tool arguments, and provider environment
until Kimi tool-subprocess env scrubbing has been verified. Do not add Kimi
live evals to public CI or run them against untrusted PR scenarios.

Note: Gauntlet's own `gauntlet` CLI preserves its `--target <binary>` flag for
selecting the TUI adapter binary; quorum's `--coding-agent` flag is a
separate, higher-level concept that selects the agent config.

### OpenCode

`coding-agents/opencode.yaml` launches OpenCode CLI as `opencode`. It requires
`SUPERPOWERS_ROOT` because quorum stages the local Superpowers OpenCode plugin
and skills into each run's isolated config home. The runner creates a per-run
`OPENCODE_QUORUM_HOME`, seeds isolated XDG dirs, copies
`.opencode/plugins/superpowers.js`, copies the `skills/` tree, links the plugin
into `.config/opencode/plugins/`, and rejects symlinks or stale session exports
before launch.

The generated launcher starts interactive OpenCode from the scenario workdir
with an allowlisted environment:

```bash
opencode run -i --dangerously-skip-permissions
```

Before launch, quorum runs a throwaway provider preflight:

```bash
opencode run --dangerously-skip-permissions "Reply with EXACTLY OK."
```

OpenCode stores sessions outside simple JSON transcript files, so quorum
captures behavior by snapshotting `opencode session list --format json` before
Gauntlet, exporting matching new sessions after Gauntlet, and normalizing the
exported files under:

```text
<run>/coding-agent-config/.quorum/session-exports/[0-9]*-ses_*.json
```

The manifest at:

```text
<run>/coding-agent-config/.quorum/session-exports/opencode-session-export-manifest.json
```

records raw session rows, cwd-filter decisions, skipped existing sessions, and
export metadata. The manifest is diagnostic evidence only and is excluded from
normalization.

### Pi

`coding-agents/pi.yaml` launches Pi as `pi`. It requires `SUPERPOWERS_ROOT`,
`PI_PROVIDER`, `PI_MODEL`, and `PI_API_KEY`. quorum creates an isolated per-run
`PI_CODING_AGENT_DIR` under `<run>/coding-agent-config` and writes:

```text
<run>/coding-agent-config/auth.json
<run>/coding-agent-config/settings.json
<run>/coding-agent-config/pi.env
<run>/coding-agent-config/sessions/*.jsonl
```

`auth.json` references `$PI_API_KEY` instead of embedding the key; `pi.env`
contains the real runtime secret and is chmod `0600`. Pi run directories are
secret-bearing artifacts.

The generated launcher starts Pi with:

```bash
PI_CODING_AGENT_DIR="$PI_CODING_AGENT_DIR" \
pi \
  --config-dir "$PI_CODING_AGENT_DIR" \
  --no-context-files \
  --extension "$SUPERPOWERS_ROOT" \
  --allow-tool RunCommand \
  --allow-tool Edit
```

Pi loads the Superpowers extension and skills from the local
`SUPERPOWERS_ROOT`, so globally installed Pi packages or `~/.agents/skills`
cannot satisfy the eval accidentally. Raw Pi sessions are captured from:

```text
<run>/coding-agent-config/sessions/*.jsonl
```

Pi runs are priced through obol's `pi` dialect (PRI-2130):
`coding-agent-token-usage.json` is written whenever obol can parse the
captured session, and omitted otherwise (`economics.partial: true`).

### Copilot

`coding-agents/copilot.yaml` launches GitHub Copilot CLI as `copilot`. Its
context lives in `coding-agents/copilot-context/HOWTO.md`, and quorum generates
the per-run launcher from `coding-agents/copilot-context/launch-agent`.

quorum creates an isolated `COPILOT_HOME` under `<run>/coding-agent-config`,
writes a chmod-0600 `.copilot-env`, stages Superpowers under
`plugins/superpowers`, and launches Copilot from the scenario workdir with:

```bash
copilot \
  --plugin-dir <run>/coding-agent-config/plugins/superpowers \
  --session-id <run-session-id> \
  --allow-all \
  --no-auto-update \
  --no-remote \
  --disable-builtin-mcps \
  --secret-env-vars=<secret-env-var-names> \
  --log-dir <run>/coding-agent-config/logs
```

The launcher uses an allowlisted outer environment. Auth can come from
`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `gh auth token`, or
`COPILOT_PROVIDER_BASE_URL`. Proxy URLs with embedded credentials are rejected;
remove the userinfo from `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and lowercase
variants before running Copilot evals.

Copilot's primary trace is strict session state:

```text
<run>/coding-agent-config/session-state/<run-session-id>/events.jsonl
```

quorum normalizes that file into `<run>/coding-agent-tool-calls.jsonl` and
fails closed if the expected session-state file is missing, empty after
normalization, or accompanied by unexpected session-state files. Plugin staging
is validated by files under `plugins/superpowers`, but behavioral validation
comes from native `Skill` rows in the normalized trace. Do not use
`copilot plugin list` as the validation source; it currently reports no
plugins for the staged root.

Live smoke:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers uv run quorum run scenarios/copilot-superpowers-bootstrap --coding-agent copilot
```

## How a Run Works

A `quorum run` drives one scenario against one Coding-Agent:

1. **Coding-Agent config** — `coding-agents/<name>.yaml` is parsed and
   its required env vars validated.
2. **Run dir** — a per-run directory is created under `results/`. It
   doubles as Gauntlet's `--state-dir` root and the evidence root.
3. **Isolation** — a fresh per-run agent-config dir (`CLAUDE_CONFIG_DIR` for
   Claude, `CODEX_HOME` for Codex, `ANTIGRAVITY_CONFIG_DIR` for Antigravity,
   `GEMINI_CLI_HOME` for Gemini, `KIMI_CODE_HOME` for Kimi,
   `OPENCODE_QUORUM_HOME` for OpenCode, `PI_CODING_AGENT_DIR` for Pi, and
   `COPILOT_HOME` for Copilot) is seeded or provisioned, so the Coding-Agent
   never sees the host's real `~/.claude`, `~/.codex`, `~/.gemini`,
   `~/.kimi-code`, OpenCode state, `~/.pi` state, or `~/.copilot` state,
   installed plugins, or prior sessions. Antigravity also runs an isolated auth
   preflight and plugin install before launch; Gemini links the local
   Superpowers extension before launch; Kimi gets an isolated local-path
   Superpowers plugin install before launch; OpenCode stages the plugin and
   runs an isolated provider preflight; Pi writes run-local auth, settings, and
   environment files; Copilot stages the plugin and writes a private
   `.copilot-env` before launch.
4. **Setup** — the Coding-Agent's workdir is created inside the run dir as
   `coding-agent-workdir/`; the scenario's `setup.sh` builds the fixture.
5. **Pre-checks** — `checks.sh`'s `pre()` runs against the workdir; a failure
   marks the run `indeterminate` before the Coding-Agent is launched.
6. **Context** — the per-agent HOWTO (`coding-agents/<name>-context/`)
   is copied into the run's `gauntlet-agent/context/` so the Gauntlet-Agent
   learns how to launch and observe the Coding-Agent.
7. **Drive** — `gauntlet run story.md --adapter tui --state-dir gauntlet-agent`
   launches. The Gauntlet-Agent reads the screen and the Coding-Agent's session
   log via bash, role-plays the user, and issues a verdict against the story's
   `## Acceptance Criteria`.
8. **Capture** — the Coding-Agent's session-log dir is diffed, normalized into
   `coding-agent-tool-calls.jsonl`, and token usage is written to
   `coding-agent-token-usage.json` (measurement only). OpenCode exports matching
   new sessions before this diff step. Antigravity, Gemini, Kimi, OpenCode, Pi,
   and Copilot runs fail closed as `indeterminate` if no transcript/session
   export or session-state file is captured, or captured logs normalize to zero
   tool-call rows.
9. **Post-checks** — `checks.sh`'s `post()` runs against the captured evidence.
10. **Compose** — the final verdict is `pass` iff the Gauntlet-Agent passed
    **and** every post-check passed. `verdict.json` is written to the run dir.

## Writing a Scenario

1. `uv run quorum new <name>` stamps a structurally-valid skeleton.
2. Write `story.md`: brief the Gauntlet-Agent on the role it plays, the exact
   message to send the Coding-Agent, and when it is done — plus
   evidence-demanding acceptance criteria. Follow the
   `writing-gauntlet-stories` skill.
3. Write `setup.sh` to build the fixture. Prefer
   `uv run setup-helpers run <helper>` over inline Python; if you need a new
   fixture, add a helper to `setup_helpers/` and register it in
   `setup_helpers/__init__.py`.
4. Write `checks.sh` with `pre()` and `post()` functions using the
   `bin/` vocabulary. No exec bit.
5. `uv run quorum check <name>` to validate structure, then run it against a
   Coding-Agent.

Setup scripts run with `$QUORUM_WORKDIR` pointing at the fixture workdir.
Check tools run from the fixture workdir with `bin/` on `PATH`.
Post-checks that need sibling run artifacts can use `$QUORUM_RUN_DIR`.

## Refreshing the Claude Skeleton

The dialog-bypass skeleton at `coding-agents/claude-home-skeleton/` is
committed — fresh checkouts, worktrees, and CI runners boot Claude straight
to the prompt with no per-machine setup. It carries only the ~12 universal
dialog-bypass flags (`hasCompletedOnboarding`, `installMethod`, migration
markers, etc.); the refresh script scrubs all per-user, per-machine, and
per-key fields before writing.

Refresh only when Claude Code adds new onboarding state (a previously-skipped
picker reappearing in a tmux attach is the usual symptom):

```bash
# 1. Run Claude with a fresh config dir; click through every dialog with your
#    real ANTHROPIC_API_KEY active. Once you reach the prompt, /exit.
CLAUDE_CONFIG_DIR=/tmp/claude-source claude

# 2. Rebuild the fixture; commit the diff.
bin/refresh-claude-home-skeleton --source /tmp/claude-source
git diff coding-agents/claude-home-skeleton/   # sanity-check the scrubbed result
git commit coding-agents/claude-home-skeleton/ -m "quorum: refresh Claude skeleton"
```

Codex, Antigravity, Gemini, Kimi, OpenCode, Pi, and Copilot need no committed
home skeleton. Codex provisions a fresh per-run home from your
`OPENAI_API_KEY`; Antigravity provisions an isolated per-run
`ANTIGRAVITY_CONFIG_DIR`, runs its auth preflight, and installs the Superpowers
plugin from `SUPERPOWERS_ROOT`; Gemini seeds API-key auth and links the local
extension; Kimi provisions a fresh per-run `KIMI_CODE_HOME` and installs only
the local-path Superpowers plugin from `SUPERPOWERS_ROOT`; OpenCode stages the
plugin and skills from `SUPERPOWERS_ROOT` into isolated XDG dirs; Pi provisions
run-local auth, settings, and env files under `PI_CODING_AGENT_DIR`; Copilot
stages the plugin from `SUPERPOWERS_ROOT` into isolated `COPILOT_HOME`.

## Safe Checks

These are the checks expected in CI and on routine PRs:

```bash
uv run ruff check
uv run ty check
uv run quorum check
uv run pytest
```

## Project Map

```text
quorum/                   quorum CLI and runtime
  cli.py                `quorum run`, `list`, `new`, `check`, `show`, `run-all`
  runner.py             per-run orchestration (one scenario, one coding-agent)
  coding_agent_config.py  per-coding-agent YAML loader
  setup_step.py         runs scenario setup.sh
  checks.py             sources checks.sh, runs pre()/post(), collects records
  capture.py            session-log snapshot/diff + obol-priced token capture
  normalizers.py        per-coding-agent session-log normalization
  composer.py           three-valued verdict from gauntlet + checks layers
  scaffold.py           `quorum new` / `quorum check`
  show.py               verdict renderer for triage
  run_all.py            matrix runner across scenarios × coding-agents
  obol_capture.py       all obol calls: session-log + gauntlet-sidecar cost estimation
  timing.py             session-log wall-clock span (duration_ms)
bin/                    check-tool vocabulary (_record, file-exists, file-contains,
                        command-succeeds, git-repo, git-branch, git-clean, git-count,
                        tool-called, tool-count, tool-before, tool-arg-match,
                        skill-called, skill-before-tool, not, worktree-created,
                        and more); refresh-claude-home-skeleton operator script
coding-agents/          per-Coding-Agent material:
  <name>.yaml             CLI config
  <name>-context/         HOWTO prose for the Gauntlet-Agent
  <name>-home-skeleton/   committed config skeletons where needed (claude only)
scenarios/              scenarios (one directory each)
setup_helpers/          scenario fixture builders + `setup-helpers` CLI
fixtures/               shared static fixture repos (e.g. template-repo/)
docs/                   design notes, spec, testing protocols, baselines
tests/                  pytest suite (tests/quorum/ covers the package)
```

## Triage

Triaging a non-passing run: `uv run quorum show [<target>]` and see
[docs/superpowers/skills/triaging-a-failing-eval.md](docs/superpowers/skills/triaging-a-failing-eval.md)
for the attribution atlas.

For the current known-good baseline (what counts as a clean batch on
this commit, per backend), see [docs/baselines/](docs/baselines/).

### Antigravity Troubleshooting

When an Antigravity run is non-passing or indeterminate:

1. Confirm `agy` is installed and reachable: `agy --version`.
2. Confirm local browser/keyring auth works outside quorum with a one-shot
   print command, for example `agy --print "Reply with EXACTLY OK."`.
3. Inspect the CLI lifecycle log at `<run>/coding-agent-config/agy.log`.
4. Confirm the plugin files exist under
   `<run>/coding-agent-config/.gemini/config/plugins/superpowers/`.
5. Confirm raw transcripts exist under
   `<run>/coding-agent-config/.gemini/antigravity-cli/brain/**/transcript.jsonl`.
6. Inspect normalized behavior in `<run>/coding-agent-tool-calls.jsonl`; plugin
   files alone do not prove hook or skill behavior.
7. Render the verdict with `uv run quorum show <run-or-batch-id>`.
8. For broad sweep triage, classify failures with
   [docs/baselines/antigravity-sweeps/README.md](docs/baselines/antigravity-sweeps/README.md).

### OpenCode Troubleshooting

When an OpenCode run is non-passing or indeterminate:

1. Confirm `opencode` is installed and reachable: `opencode --version`.
2. Confirm provider auth works outside quorum with a one-shot command, for
   example `opencode run --dangerously-skip-permissions "Reply with EXACTLY OK."`.
3. Confirm the staged plugin exists at
   `<run>/coding-agent-config/.config/opencode/plugins/superpowers.js`.
4. Confirm the staged skills exist under
   `<run>/coding-agent-config/.config/opencode/superpowers/skills/`.
5. Inspect the export manifest at
   `<run>/coding-agent-config/.quorum/session-exports/opencode-session-export-manifest.json`.
6. Inspect normalized behavior in `<run>/coding-agent-tool-calls.jsonl`; plugin
   files alone do not prove hook or skill behavior.
7. Render the verdict with `uv run quorum show <run-or-batch-id>`.

### Pi Troubleshooting

When a Pi run is non-passing or indeterminate:

1. Confirm `pi` is installed and reachable: `pi --version`.
2. Confirm `PI_PROVIDER`, `PI_MODEL`, `PI_API_KEY`, and `SUPERPOWERS_ROOT` are
   set in the shell that launches quorum.
3. If using `azure-openai-responses`, confirm `AZURE_OPENAI_BASE_URL` or
   `AZURE_OPENAI_RESOURCE_NAME` is set.
4. Inspect `<run>/coding-agent-config/pi.env`; it should exist, be chmod
   `0600`, and contain the runtime env expected by the launcher.
5. Inspect `<run>/coding-agent-config/auth.json`; it should be chmod `0600`
   and should reference `$PI_API_KEY`, not the literal secret.
6. Confirm raw Pi sessions exist under
   `<run>/coding-agent-config/sessions/*.jsonl`.
7. If the verdict says `qa-agent-misconfigured`, look for a new Pi session
   whose header `cwd` is outside `<run>/coding-agent-workdir`.
8. If the verdict says `unusable Pi session header`, inspect the first line of
   each new Pi session for malformed JSON or missing `cwd`.
9. Inspect normalized behavior in `<run>/coding-agent-tool-calls.jsonl`.
10. Render the verdict with `uv run quorum show <run-or-batch-id>`.

### Copilot Troubleshooting

When a Copilot run is non-passing or indeterminate:

1. Confirm `copilot` is installed and reachable: `copilot --version`.
2. Confirm auth is available from `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
   `GITHUB_TOKEN`, `gh auth token`, or `COPILOT_PROVIDER_BASE_URL`.
3. Confirm the staged plugin files exist under
   `<run>/coding-agent-config/plugins/superpowers/`.
4. Confirm the expected session-state trace exists at
   `<run>/coding-agent-config/session-state/<run-session-id>/events.jsonl`.
5. Inspect normalized behavior in `<run>/coding-agent-tool-calls.jsonl`;
   behavioral validation comes from native `Skill` rows, not
   `copilot plugin list`.
6. If setup fails on a proxy variable, remove embedded credentials from the
   proxy URL and retry.
7. Render the verdict with `uv run quorum show <run-or-batch-id>`.

## Contribution Rules

This repo inherits the quality bar of `superpowers`.

- One problem per PR.
- Do not commit generated run artifacts or secrets.
- Do not add live evals to public CI.
- Use the PR template and explain the security/eval-lab risk for changes that
  touch Coding-Agent configs, shell execution, setup helpers, check tools, or
  Gauntlet-Agent input.
- Changes to behavior-shaping eval methodology need evidence, not just prose.

## Parent Submodule Bump

`superpowers-evals` is consumed by `superpowers` as the `evals` submodule.
After any PR merges to `main` here, open a follow-up PR against the parent
`superpowers` repo targeting `dev` that bumps the `evals` submodule pointer to
the merged `superpowers-evals` commit.

Do not treat a `superpowers-evals` merge as fully propagated until that parent
submodule bump PR exists.

---

Security reporting → [SECURITY.md](SECURITY.md).
