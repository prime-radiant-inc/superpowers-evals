# Superpowers Evals

Behavioral eval lab for [superpowers](https://github.com/obra/superpowers).
**Quorum** drives real coding-agent CLIs (Claude, Claude Haiku, Codex,
Antigravity, Gemini, Kimi, OpenCode, Pi, and Copilot) through a Gauntlet QA
agent and grades them against scenario acceptance criteria plus deterministic
post-checks.

Code, CLI, paths, and inline prose all use lowercase `quorum`; the capitalized
form `Quorum` appears in headings and the actor table.

This is not a generic benchmark suite. It is an eval lab for workflow
compliance: skill triggering, worktree behavior, subagent coordination,
verification reflexes, review quality, and cost-shaping patterns.

## Safety Model

quorum has two very different execution modes:

- **Static/unit checks** are safe for public CI. They run `biome`, `tsc`, and
  `bun test`. They do not call model APIs and do not launch agent CLIs.
- **Live evals** are trusted-maintainer operations. They launch Claude Code,
  Codex CLI, Antigravity CLI, Gemini CLI, Kimi Code, OpenCode CLI, Pi CLI, or
  Copilot CLI in permissive modes and collect raw transcripts, tool calls,
  filesystem state, and session logs.

Public CI must stay on the static/unit side of that line. Never add API keys,
live `quorum run …` invocations, or dangerous-mode agent launches to public
CI.

## Live Eval Risk

Live evals run the Coding-Agent under test with broad execution power:

- Claude and Claude Haiku use `--dangerously-skip-permissions`.
- Codex uses `--dangerously-bypass-approvals-and-sandbox`.
- Antigravity uses `--dangerously-skip-permissions` and relies on local
  browser/keyring auth for `agy`.
- Gemini uses `--skip-trust --approval-mode=yolo`; API-key auth is default,
  with opt-in OAuth auth for trusted local runs.
- Kimi uses `--yolo`.
- OpenCode uses `--dangerously-skip-permissions`.
- Pi uses explicit tool allowlists and API-key auth in a run-local config dir.
- Copilot uses `--allow-all`.

quorum pins each Coding-Agent's `HOME` (plus the XDG base dirs and `TMPDIR`)
to a throwaway per-run home at `<run>/home` — the launcher splices in the
`$QUORUM_HOME_ENV` token built by `src/agents/home-env.ts` (`xdgHomeEnv`, the
single source of truth). Each agent's config dir is collapsed *under* that home
(Claude `.claude`, Codex `.codex`, Gemini `.`, OpenCode `.`, Antigravity `.`,
Copilot `.copilot`, Kimi `.kimi-code`, Pi `.pi/agent`), so the Coding-Agent
finds its config via its own `$HOME` default and never sees the host's real
`~/.claude`, `~/.codex`, `~/.gemini`, `~/.kimi-code`, `~/.pi`, `~/.copilot`,
`~/.config`, or other home-relative state, installed plugins, or prior sessions.
Provisioning seeds the config — and the host OAuth creds each agent needs — into
that throwaway home before launch, so there is no run-time login. Copilot also
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
bun install
```

Run one scenario:

```bash
bun run quorum run scenarios/triggering-writing-plans --coding-agent claude
```

Agent names are `claude`, `claude-haiku`, `codex`, `antigravity`, `gemini`,
`kimi`, `opencode`, `pi`, and `copilot`; not every scenario is valid for every
agent.

Trusted-maintainer Claude Haiku smoke:

```bash
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
export ANTHROPIC_API_KEY=...
bun run quorum run scenarios/00-quorum-smoke-hello-world \
  --coding-agent claude-haiku \
  --out-root results/claude-haiku-smoke
bun run quorum show <run-dir>
```

Do not wire Claude Haiku live evals to public CI; it uses the same Anthropic
API-key path and broad Claude Code execution permissions as the `claude` target.

List scenarios:

```bash
bun run quorum list
```

Scaffold and validate a new scenario:

```bash
bun run quorum new my-new-scenario
bun run quorum check my-new-scenario
```

`quorum check` with no arguments validates every scenario.

Run the full matrix:

```bash
bun run quorum run-all --coding-agents claude,codex --jobs 2
```

`run-all` runs every scenario against every Coding-Agent, filtered by each
scenario's `# coding-agents:` directive. View the resulting matrix with
`bun run quorum show <batch-id>`.

For all-harness trusted-maintainer sweeps, do not put every Coding-Agent in one
`run-all --jobs N` command when you need a hard global concurrency cap. Agents
with `max_concurrency: 1` in `coding-agents/*.yaml` run in dedicated lanes beside
the shared `--jobs` pool, so one broad batch can exceed `N` live cells.

Prefer grouped batches:

```bash
set -a; source .env; set +a
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
export GEMINI_AUTH_TYPE=oauth-personal
export SCENARIOS="scenario-a,scenario-b"
export LOGDIR="results/runlogs/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$LOGDIR"

# Use the repo-owned logger instead of hand-written shell wrappers. It runs
# under bash even when launched from zsh and records exit status in the log.

# Uncapped targets share the --jobs pool.
scripts/run-with-log --log "$LOGDIR/uncapped.log" -- bun run quorum run-all \
  --coding-agents claude,claude-haiku,claude-sonnet,codex,kimi \
  --scenarios "$SCENARIOS" \
  --jobs 4 \
  --no-cursor

# Capped or fragile targets run one serial column per batch. Launch several
# single-column batches in parallel only when their backends do not interfere.
scripts/run-with-log --log "$LOGDIR/copilot.log" -- \
  bun run quorum run-all --coding-agents copilot --scenarios "$SCENARIOS" --jobs 1 --no-cursor &
scripts/run-with-log --log "$LOGDIR/opencode.log" -- \
  bun run quorum run-all --coding-agents opencode --scenarios "$SCENARIOS" --jobs 1 --no-cursor &
scripts/run-with-log --log "$LOGDIR/pi.log" -- \
  bun run quorum run-all --coding-agents pi --scenarios "$SCENARIOS" --jobs 1 --no-cursor &
scripts/run-with-log --log "$LOGDIR/gemini.log" -- \
  bun run quorum run-all --coding-agents gemini --scenarios "$SCENARIOS" --jobs 1 --no-cursor &
wait

# Keep Antigravity separate from Gemini to avoid Google/Gemini auth or quota
# noise while collecting clean capture.
scripts/run-with-log --log "$LOGDIR/antigravity.log" -- \
  bun run quorum run-all --coding-agents antigravity --scenarios "$SCENARIOS" --jobs 1 --no-cursor
```

Trusted-maintainer Antigravity sweep:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers bun run quorum run-all --coding-agents antigravity --jobs 1
```

Do not wire Antigravity live evals to public CI; they launch `agy` with
`--dangerously-skip-permissions` and depend on local browser/keyring auth.

Trusted-maintainer Gemini smoke:

```bash
export GEMINI_API_KEY=...
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
bun run quorum run scenarios/gemini-superpowers-bootstrap --coding-agent gemini
bun run quorum show <run-dir>
```

To use an existing Gemini OAuth login instead of API-key auth, set
`GEMINI_AUTH_TYPE=oauth-personal`. quorum copies `oauth_creds.json` and
`google_accounts.json` from `GEMINI_OAUTH_HOME` or `~/.gemini` into the
isolated per-run Gemini home.

Do not wire Gemini live evals to public CI; they launch `gemini` with
`--approval-mode=yolo` and preserve secret-bearing run artifacts.

Trusted-maintainer Kimi smoke:

```bash
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
export KIMI_MODEL_API_KEY=...
bun run quorum run scenarios/kimi-superpowers-bootstrap --coding-agent kimi
```

For a Kimi-only sweep:

```bash
bun run quorum run-all --coding-agents kimi --jobs 1
```

Kimi runs find their config at `<run>/home/.kimi-code` (collapsed under the
throwaway home) and do not read or symlink the host's `~/.kimi-code`;
provisioning seeds the Superpowers plugin and the host's Kimi OAuth creds there
before launch. Auth/model config comes from `KIMI_MODEL_API_KEY` (or a seeded
OAuth login) plus Quorum's default Kimi provider env. `KIMI_MODEL_NAME` may be
overridden; other host `KIMI_MODEL_*` overrides are rejected in v1 for
reproducibility.

Do not wire Kimi live evals to public CI. They launch `kimi --yolo`, write raw
`wire.jsonl` model/tool logs, and should not be run against untrusted PR
scenarios until Kimi tool-subprocess env scrubbing has been verified.

Trusted-maintainer OpenCode bootstrap smoke:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers bun run quorum run scenarios/opencode-superpowers-bootstrap --coding-agent opencode
```

Do not wire OpenCode live evals to public CI; they launch `opencode` with
`--dangerously-skip-permissions` and depend on local provider credentials.

Trusted-maintainer Pi bootstrap smoke:

```bash
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
export PI_PROVIDER=openai
export PI_MODEL=gpt-5.5
export PI_API_KEY=...
bun run quorum run scenarios/pi-superpowers-bootstrap --coding-agent pi
bun run quorum show <run-dir>
```

Do not wire Pi live evals to public CI; they launch `pi` with broad tool
allowlists and preserve secret-bearing run artifacts.

Trusted-maintainer Copilot bootstrap smoke:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers bun run quorum run scenarios/copilot-superpowers-bootstrap --coding-agent copilot
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
| **Coding-Agent** | The agent under test — the SUT. Instances: **Claude**, **Claude Haiku**, **Codex**, **Antigravity**, **Gemini**, **Kimi**, **OpenCode**, **Pi**, **Copilot**. | config + session log under its throwaway `$HOME` at `<run>/home/…`; the files it writes → `<run>/coding-agent-workdir/` |
| **Quorum** | The TypeScript/Bun wrapper. Owns setup, Coding-Agent adaptation, deterministic checks, and the final verdict. | repo `superpowers-evals/src/`; `<run>/verdict.json` |

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
Invoke check tools by bare name — they are bash functions defined by the check
prelude (`src/checks/prelude.sh`), which the runner sources before each
scenario script (via `bash -c` for `checks.sh` and `BASH_ENV` for `setup.sh`).
There is no `bin/` directory and no PATH prepend; each function delegates to a
TypeScript dispatcher (`src/cli/check-tool.ts` for the FS verbs and `not`,
`src/cli/check-transcript.ts` for trace verbs, `src/setup-helpers/cli.ts` for
`setup-helpers`).

### Check Vocabulary

Every check emits one JSON record per invocation. A non-zero exit means the
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
- `assert-checkout-clean <path>` — passes iff `<path>` is a git work tree whose `git status --porcelain` is empty (`.quorum-launch-cwd` is ignored) and, when `record_head` recorded a HEAD at setup, HEAD is unmoved. Fails closed if `git status` errors. Pair with the `record_head` setup helper for drift detection.

**Trace surface** — the Coding-Agent's normalized ATIF trajectory (`trajectory.json`),
read by the `check-transcript <verb>` tool. The 13 verbs:
- `check-transcript tool-called <tool>` — the tool appears in the trace at least once.
- `check-transcript tool-not-called <tool>` — the tool never appears in the trace.
- `check-transcript tool-count <tool> <op> <n>` — the call count satisfies the comparison.
- `check-transcript tool-before <a> <b>` — tool `a` was called before tool `b`.
- `check-transcript tool-arg-match <tool> --eq key=value | --matches key=regex [--ignore-case]` — at least one call to `tool` has args matching every matcher.
- `check-transcript tool-match-before-tool-match <tool-a> <regex-a> <tool-b> <regex-b>` — a matching call to `a` precedes a matching call to `b`.
- `check-transcript skill-called <skill>` — a `Skill` invocation (native or via SKILL.md read) names the given skill.
- `check-transcript skill-not-called <skill>` — no `Skill` invocation names the given skill.
- `check-transcript skill-before-tool <skill> <tool>` — the skill was invoked before the tool.
- `check-transcript skill-before-implementation-tool <skill> <tool>` — the skill was invoked before an implementation-path call to `tool`.
- `check-transcript implementation-tool-not-called <tool>` — no implementation-path call to `tool` occurred.
- `check-transcript investigated` — at least one investigation (native Read/Grep, or `grep`/`rg` via Bash) occurred.
- `check-transcript worktree-created` — a worktree was created (native `EnterWorktree`, or `git worktree add` via Bash).

**Negation:**
- `not <check> [args…]` — runs the inner check without emitting a record, inverts the result, and emits one negated record. Always use `not` rather than bash's bare `!`.

Record emission is centralized in the dispatcher (`src/check/record.ts` is the
sole emitter, writing to `QUORUM_RECORD_SINK`), and a crashing check lands in
the 127 crash-band so it never silently drops out of the verdict.

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
├── home/                            the Coding-Agent's throwaway $HOME (config
│                                    collapsed under it, e.g. home/.claude,
│                                    home/.codex, home/.gemini)
├── trajectory.json                 the Coding-Agent's normalized ATIF trace
└── coding-agent-token-usage.json    the Coding-Agent's token cost
```

`results/` is gitignored because run artifacts can contain sensitive
transcripts.

## Coding-Agents

A Coding-Agent is one agent CLI under test. Its config is
`coding-agents/<name>.yaml`; its companion HOWTO,
`coding-agents/<name>-context/HOWTO.md`, is prose the Gauntlet-Agent reads to
learn how to launch and observe that CLI. Every agent runs with `HOME` pinned
to the throwaway per-run home at `<run>/home` and its config collapsed under it
(the `home_config_subdir` in `coding-agents/<name>.yaml`); provisioning seeds
that config — and any host creds — before launch. Claude seeds its config under
`<run>/home/.claude` — a project-trust block + API-key approval, no onboarding
skeleton (Codex seeds its config under `<run>/home/.codex` from
local ChatGPT subscription auth at `~/.codex/auth.json`; Antigravity and Gemini
seed isolated `.gemini` state under the home, seeding host OAuth creds; Kimi
seeds config + host OAuth under `<run>/home/.kimi-code`; OpenCode stages the
local Superpowers plugin and skills under the home's XDG dirs; Pi seeds
run-local auth and settings under `<run>/home/.pi/agent`; Copilot stages the
local Superpowers plugin under `<run>/home/.copilot` and writes a private
`.copilot-env`). All authored once per agent and shared across scenarios.
`claude-haiku` is a Claude Code target variant that uses the Claude
runtime/context and the same `ANTHROPIC_API_KEY` path as `claude`.

| Coding-Agent | CLI | Required environment |
| --- | --- | --- |
| `claude` | Claude Code | `ANTHROPIC_API_KEY`, `SUPERPOWERS_ROOT` |
| `claude-haiku` | Claude Code (Haiku target variant) | `ANTHROPIC_API_KEY`, `SUPERPOWERS_ROOT` |
| `codex` | Codex CLI | `SUPERPOWERS_ROOT`; local ChatGPT subscription login via `codex login` |
| `antigravity` | Google Antigravity CLI (`agy`) | `SUPERPOWERS_ROOT` |
| `gemini` | Gemini CLI (`gemini`) | `GEMINI_API_KEY` or `GEMINI_AUTH_TYPE=oauth-personal`; `SUPERPOWERS_ROOT` |
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

`coding-agents/gemini.yaml` launches Gemini CLI as `gemini`. Its config dir is
collapsed onto the throwaway home (`home_config_subdir: "."`), so quorum seeds
its `.gemini` state directly under `<run>/home/.gemini`, writes a chmod-0600
runtime env file, seeds auth in `.gemini/settings.json`, and links Superpowers
from local `SUPERPOWERS_ROOT` with:

```bash
gemini extensions link "$SUPERPOWERS_ROOT" --consent
```

The generated launcher starts interactive Gemini from the scenario workdir. It
pins `HOME` (+ XDG + `TMPDIR`) via `$QUORUM_HOME_ENV` and sets NO
`GEMINI_CLI_HOME` — gemini finds the seeded config via its `$HOME` default:

```bash
$QUORUM_HOME_ENV \
GEMINI_DEFAULT_AUTH_TYPE=<gemini-api-key|oauth-personal> \
GEMINI_CLI_TRUST_WORKSPACE=true \
gemini --skip-trust --approval-mode=yolo
```

By default, Gemini uses `GEMINI_AUTH_TYPE=gemini-api-key`; quorum requires
`GEMINI_API_KEY` and writes it into the run-local `.gemini-env` file. For a
trusted local OAuth run, set `GEMINI_AUTH_TYPE=oauth-personal`; quorum copies
`oauth_creds.json` and `google_accounts.json` from `GEMINI_OAUTH_HOME` or
`~/.gemini` into the isolated run home and leaves `.gemini-env` empty.

Gemini run artifacts are secret-bearing live-eval artifacts because the
isolated config dir can contain the per-run `.gemini-env` file or copied OAuth
credentials. Do not commit, paste, or publish Gemini run directories without
scrubbing them.

Provisioning verifies that Gemini linked and enabled Superpowers by checking:

```text
<run>/home/.gemini/extensions/superpowers/.gemini-extension-install.json
<run>/home/.gemini/extensions/extension-enablement.json
<run>/home/.gemini/extension_integrity.json
```

Those files prove the extension was linked. They do not prove Gemini honored
Superpowers behavior. Behavioral evidence comes from normalized transcript rows
in `<run>/trajectory.json` and from raw Gemini transcripts at:

```text
<run>/home/.gemini/tmp/**/chats/**/*.json*
```

Live smoke:

```bash
export GEMINI_API_KEY=...
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
bun run quorum run scenarios/gemini-superpowers-bootstrap --coding-agent gemini
bun run quorum show <run-dir>
```

OAuth smoke:

```bash
export GEMINI_AUTH_TYPE=oauth-personal
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
bun run quorum run scenarios/gemini-superpowers-bootstrap --coding-agent gemini
bun run quorum show <run-dir>
```

### Antigravity

`coding-agents/antigravity.yaml` launches Google Antigravity CLI as `agy`.
It requires `SUPERPOWERS_ROOT` because quorum installs the local Superpowers
plugin into each run's isolated Antigravity config. Antigravity's config dir is
collapsed onto the throwaway home (`home_config_subdir: "."`), so
`ANTIGRAVITY_CONFIG_DIR` resolves to `<run>/home` and its `.gemini` state lives
at `<run>/home/.gemini`. The generated launcher starts interactive `agy` from
the scenario workdir, pinning `HOME` (+ XDG + `TMPDIR`) via `$QUORUM_HOME_ENV`:

```bash
$QUORUM_HOME_ENV \
ANTIGRAVITY_CONFIG_DIR="$ANTIGRAVITY_CONFIG_DIR" \
AGY_CLI_DISABLE_AUTO_UPDATE=true \
agy \
  --gemini_dir="$ANTIGRAVITY_CONFIG_DIR/.gemini" \
  --add-dir="$QUORUM_AGENT_CWD" \
  --dangerously-skip-permissions \
  --log-file "$ANTIGRAVITY_CONFIG_DIR/agy.log"
```

`agy` reads its live, rotating OAuth token from `$HOME/.gemini/oauth_creds.json`
at runtime, so provisioning seeds the host's OAuth creds into the throwaway
home's `.gemini` before launch (the keyring entry is per-login-user, so it
survives the throwaway `$HOME`). `ANTIGRAVITY_CONFIG_DIR` and the explicit
`--gemini_dir` are kept belt-and-braces — both already resolve to the same
collapsed `.gemini` the `$HOME` default would pick, but they pin the state seam
to a known path; keep them inside the runner/launcher path, not in scenarios.
`AGY_CLI_DISABLE_AUTO_UPDATE` keeps runs from mutating themselves mid-eval.
Before launch, quorum runs an auth/isolation preflight using a throwaway
`--gemini_dir`, then installs the plugin into the real per-run config with:

```bash
agy --gemini_dir="$ANTIGRAVITY_CONFIG_DIR/.gemini" plugin install "$SUPERPOWERS_ROOT"
```

Antigravity auth is local browser/keyring state owned by the maintainer running
the eval. It is not an environment-only CI credential model, and Antigravity
live evals must not be added to public CI.

Provisioning verifies that `plugin.json`, `hooks.json`, and
`skills/using-superpowers/SKILL.md` exist under:

```text
<run>/home/.gemini/config/plugins/superpowers/
```

Those files prove the plugin was installed. They do not prove hook or skill
behavior. Behavioral evidence comes from normalized transcript rows in
`<run>/trajectory.json` and from raw Antigravity transcripts at:

```text
<run>/home/.gemini/antigravity-cli/brain/**/transcript.jsonl
```

The Antigravity CLI lifecycle/debug log is:

```text
<run>/home/agy.log
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

Kimi's config dir is collapsed onto the throwaway home
(`home_config_subdir: ".kimi-code"`), so quorum seeds its config — plus the
host's Kimi OAuth creds — under `<run>/home/.kimi-code` and does not read or
symlink the host's `~/.kimi-code`. Before launch, quorum writes
`plugins/installed.json` with a single enabled Superpowers plugin whose
`source` is `local-path` and whose root realpath matches `SUPERPOWERS_ROOT`.
The runtime must not contain a copied `plugins/managed/superpowers` plugin.

The launcher pins `HOME` (+ XDG + `TMPDIR`) via `$QUORUM_HOME_ENV`, sets NO
`KIMI_CODE_HOME` (kimi finds its config via its `$HOME` default), and launches
with:

```bash
$QUORUM_HOME_ENV kimi --yolo
```

Kimi run artifacts are sensitive. In addition to the normalized
`<run>/trajectory.json`, raw Kimi wire logs may appear at:

```text
<run>/home/.kimi-code/sessions/**/wire.jsonl
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
and skills into each run's isolated config home. OpenCode's config dir is
collapsed onto the throwaway home (`home_config_subdir: "."`), which doubles as
`OPENCODE_QUORUM_HOME`; the runner pins the home and its XDG dirs, copies
`.opencode/plugins/superpowers.js`, copies the `skills/` tree, links the plugin
into `.config/opencode/plugins/`, and rejects symlinks or stale session exports
before launch. OpenCode keys its session DB off `XDG_DATA_HOME`, so pinning the
throwaway home keeps the launcher and the capture subprocess on the same store.

The generated launcher starts interactive OpenCode from the scenario workdir
with an allowlisted environment. It pins `HOME` (+ XDG + `TMPDIR`) via
`$QUORUM_HOME_ENV` and sets `OPENCODE_CONFIG_DIR=<home>/.config/opencode`:

```bash
$QUORUM_HOME_ENV OPENCODE_CONFIG_DIR="$QUORUM_AGENT_HOME/.config/opencode" \
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
<run>/home/.quorum/session-exports/[0-9]*-ses_*.json
```

The manifest at:

```text
<run>/home/.quorum/session-exports/opencode-session-export-manifest.json
```

records raw session rows, cwd-filter decisions, skipped existing sessions, and
export metadata. The manifest is diagnostic evidence only and is excluded from
normalization.

### Pi

`coding-agents/pi.yaml` launches Pi as `pi`. It requires `SUPERPOWERS_ROOT`,
`PI_PROVIDER`, `PI_MODEL`, and `PI_API_KEY`. Pi's config dir is collapsed onto
the throwaway home (`home_config_subdir: ".pi/agent"`), so quorum seeds its
config under `<run>/home/.pi/agent` and writes:

```text
<run>/home/.pi/agent/auth.json
<run>/home/.pi/agent/settings.json
<run>/home/.pi/agent/pi.env
<run>/home/.pi/agent/sessions/**/*.jsonl
```

`auth.json` references `$PI_API_KEY` instead of embedding the key; `pi.env`
contains the real runtime secret and is chmod `0600`. Pi run directories are
secret-bearing artifacts.

The generated launcher pins `HOME` (+ XDG + `TMPDIR`) via `$QUORUM_HOME_ENV` and
sets NO `PI_CODING_AGENT_DIR` and NO `--session-dir`/`--config-dir` — pi finds
its seeded config and writes sessions via its `$HOME` defaults
(`$HOME/.pi/agent` and `<config>/sessions`). It starts Pi with:

```bash
$QUORUM_HOME_ENV \
pi \
  --provider "$PI_PROVIDER" \
  --model "$PI_MODEL" \
  --no-extensions \
  --extension "$SUPERPOWERS_ROOT" \
  --extension "$PI_SUBAGENTS_PKG" \
  --no-skills \
  --skill "$SUPERPOWERS_ROOT/skills" \
  --no-context-files \
  --tools read,bash,edit,write,grep,find,ls,subagent
```

Pi loads the Superpowers extension and skills from the local
`SUPERPOWERS_ROOT`, so globally installed Pi packages or `~/.agents/skills`
cannot satisfy the eval accidentally — with one deliberate exception: the
launcher loads the `pi-subagents` package (host prerequisite:
`npm install -g pi-subagents`), which provides the `subagent` delegation
tool. The launcher resolves it via `npm root -g` and fails loudly when it
is missing. pi-subagents reads agent definitions from `$HOME/.agents` in
addition to the per-run config dir; because the launcher pins `HOME` to the
throwaway home, that path now resolves under `<run>/home/.agents` rather than
the operator's real `~/.agents`, alongside the package's bundled agents
(reviewer, worker, scout, ...). Raw Pi sessions are captured from:

```text
<run>/home/.pi/agent/sessions/**/*.jsonl
```

Pi runs are priced through obol's `pi` dialect (PRI-2130):
`coding-agent-token-usage.json` is written whenever obol can parse the
captured session, and omitted otherwise (`economics.partial: true`).

### Copilot

`coding-agents/copilot.yaml` launches GitHub Copilot CLI as `copilot`. Its
context lives in `coding-agents/copilot-context/HOWTO.md`, and quorum generates
the per-run launcher from `coding-agents/copilot-context/launch-agent`.

Copilot's config dir is collapsed onto the throwaway home
(`home_config_subdir: ".copilot"`), so quorum seeds its config under
`<run>/home/.copilot`, writes a chmod-0600 `.copilot-env`, stages Superpowers
under `<run>/home/.copilot/plugins/superpowers`, and launches Copilot from the
scenario workdir. The launcher pins `HOME` (+ XDG + `TMPDIR`) via
`$QUORUM_HOME_ENV` and sets NO `COPILOT_HOME` — copilot resolves its home to
`$HOME/.copilot`, where provisioning seeded the config:

```bash
$QUORUM_HOME_ENV \
COPILOT_CACHE_HOME=<run>/home/.copilot/.cache \
copilot \
  --plugin-dir <run>/home/.copilot/plugins/superpowers \
  --session-id <run-session-id> \
  --allow-all \
  --no-auto-update \
  --no-remote \
  --disable-builtin-mcps \
  --secret-env-vars=<secret-env-var-names> \
  --log-dir <run>/home/.copilot/logs
```

The launcher uses an allowlisted outer environment. Auth can come from
`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `gh auth token`, or
`COPILOT_PROVIDER_BASE_URL`. Proxy URLs with embedded credentials are rejected;
remove the userinfo from `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and lowercase
variants before running Copilot evals.

Copilot's primary trace is strict session state:

```text
<run>/home/.copilot/session-state/<run-session-id>/events.jsonl
```

quorum normalizes that file into `<run>/trajectory.json` and
fails closed if the expected session-state file is missing, empty after
normalization, or accompanied by unexpected session-state files. Plugin staging
is validated by files under `plugins/superpowers`, but behavioral validation
comes from native `Skill` rows in the normalized trace. Do not use
`copilot plugin list` as the validation source; it currently reports no
plugins for the staged root.

Live smoke:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers bun run quorum run scenarios/copilot-superpowers-bootstrap --coding-agent copilot
```

## How a Run Works

A `quorum run` drives one scenario against one Coding-Agent:

1. **Coding-Agent config** — `coding-agents/<name>.yaml` is parsed and
   its required env vars validated.
2. **Run dir** — a per-run directory is created under `results/`. It
   doubles as Gauntlet's `--state-dir` root and the evidence root.
3. **Isolation** — a throwaway per-run `$HOME` is created at `<run>/home` and
   the launcher pins `HOME` (+ the XDG base dirs and `TMPDIR`) to it via the
   `$QUORUM_HOME_ENV` token. Each agent's config dir is collapsed *under* that
   home (`.claude`, `.codex`, `.gemini`, `.kimi-code`, `.pi/agent`, `.copilot`,
   etc.), and provisioning seeds the config plus any host creds there before
   launch, so the Coding-Agent finds its config via its own `$HOME` default and
   never sees the host's real `~/.claude`, `~/.codex`, `~/.gemini`,
   `~/.kimi-code`, OpenCode state, `~/.pi` state, `~/.copilot` state, `~/.config`,
   installed plugins, or prior sessions. The launcher no longer sets the
   per-agent config-dir env var (the `agent_config_env` name survives only as
   the internal substitution key for `session_log_dir`). Antigravity also runs
   an isolated auth preflight, seeds host OAuth creds, and installs the plugin
   before launch; Gemini links the local Superpowers extension and seeds host
   OAuth before launch; Kimi gets an isolated local-path Superpowers plugin
   install and seeds host OAuth before launch; OpenCode stages the plugin and
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
   `trajectory.json`, and token usage is written to
   `coding-agent-token-usage.json` (measurement only). OpenCode exports matching
   new sessions before this diff step. Antigravity, Gemini, Kimi, OpenCode, Pi,
   and Copilot runs fail closed as `indeterminate` if no transcript/session
   export or session-state file is captured, or captured logs normalize to zero
   tool-call rows.
9. **Post-checks** — `checks.sh`'s `post()` runs against the captured evidence.
10. **Compose** — the final verdict is `pass` iff the Gauntlet-Agent passed
    **and** every post-check passed. `verdict.json` is written to the run dir.

## Writing a Scenario

1. `bun run quorum new <name>` stamps a structurally-valid skeleton.
2. Write `story.md`: brief the Gauntlet-Agent on the role it plays, the exact
   message to send the Coding-Agent, and when it is done — plus
   evidence-demanding acceptance criteria. Follow the
   `writing-gauntlet-stories` skill.
3. Write `setup.sh` to build the fixture. Prefer
   `setup-helpers run <helper>` over inline shell; if you need a new fixture,
   add a helper to `src/setup-helpers/` and register it in
   `src/setup-helpers/registry.ts`.
4. Write `checks.sh` with `pre()` and `post()` functions using the check
   vocabulary (bare verbs resolved from the sourced prelude). No exec bit.
5. `bun run quorum check <name>` to validate structure, then run it against a
   Coding-Agent.

Setup scripts run with `$QUORUM_WORKDIR` pointing at the fixture workdir.
Check verbs run from the fixture workdir as bash functions defined by the
sourced check prelude (`src/checks/prelude.sh`), not as `bin/` shims on `PATH`.
Post-checks that need sibling run artifacts can use `$QUORUM_RUN_DIR`.

## Per-Agent Provisioning

No agent ships a committed home skeleton — each seeds its config under the
throwaway per-run home (`<run>/home/<config-subdir>`) at provision time. Claude
seeds `<run>/home/.claude` with a project-trust block and the API-key approval:
recent claude boots straight to the prompt on `ANTHROPIC_API_KEY` auth + that
trust block (it runs and auto-completes onboarding each run), so no hand-seeded
onboarding state is needed. (`IS_DEMO=1` is not used: it skips
the first-run flow that activates auth on a never-onboarded config, so claude
comes up "Not logged in" — reproduced 2/2; the auth resolver itself is
IS_DEMO-independent.) Codex
seeds `<run>/home/.codex` from your local ChatGPT subscription login in
`~/.codex/auth.json`; Antigravity
seeds `<run>/home/.gemini`, runs its auth preflight, seeds host OAuth creds, and
installs the Superpowers plugin from `SUPERPOWERS_ROOT`; Gemini seeds run-local
auth (and host OAuth, on the OAuth path) and links the local extension; Kimi
seeds `<run>/home/.kimi-code` with host OAuth and installs only the local-path
Superpowers plugin from `SUPERPOWERS_ROOT`; OpenCode stages the plugin and
skills from `SUPERPOWERS_ROOT` under the home's XDG dirs; Pi seeds run-local
auth, settings, and env files under `<run>/home/.pi/agent`; Copilot stages the
plugin from `SUPERPOWERS_ROOT` under `<run>/home/.copilot`.

## Safe Checks

These are the checks expected in CI and on routine PRs:

```bash
bun run check          # biome ci . && tsc --noEmit && bun test — the full gate
bun run quorum check   # validate every scenario directory
```

`bun run check` is the single gate (Biome lint/format + full-strict `tsc` +
`bun test`); individual steps are `bun run lint`, `bun run typecheck`, and
`bun test`.

## Architecture

quorum is **TypeScript on Bun**. The console is `bun run quorum <cmd>` (a
[commander](https://github.com/tj/commander.js) CLI at `src/cli/index.ts`, also
exposed as the `quorum` bin); the gate is `bun run check`
(Biome + full-strict `tsc` + `bun test`).

The shapes that cross process and file boundaries — `verdict.json`, batch
indices, economics, the Gauntlet result, agent YAML — are **zod schemas** in
`src/contracts/`, validated at every boundary, so a malformed external file
fails loudly instead of corrupting a verdict. The `cli/` layer parses commands
and dispatches into the `runner/` pipeline (one scenario × one Coding-Agent) or
`run-all/` (the matrix). Per-Coding-Agent differences live in two parallel
fan-outs keyed by agent name: `agents/` seeds the agent's config under the
throwaway per-run `$HOME` (`<run>/home`), and `normalizers/` turns that agent's
session log into a uniform tool-call trace. Live agent-CLI calls and other
non-hermetic subprocesses go through the
`agents/command-runner.ts` seam, so the unit suite injects fakes and never
launches a real CLI. `scheduler/` is the shared concurrency engine under both
`run-all/` and the `dashboard/`. `env.ts` is the only module that reads
`process.env`.

```text
src/
  cli/                  commander CLI: run, list, new, check, show, run-all, dashboard
    index.ts              command wiring + the run / run-all / dashboard actions
    render.ts             verdict renderer for triage (quorum show)
    render-batch.ts       batch-matrix renderer (quorum show <batch>)
    resolve-target.ts     run/batch target resolution; scenario.ts scenario loading
  runner/               per-run orchestration (one scenario × one Coding-Agent)
    index.ts              setup → pre-checks → gauntlet drive → capture → post-checks → compose
    context.ts            populate the Gauntlet-Agent context dir (HOWTO + launch-agent shim)
    phase.ts              phase.json (setup/agent/checks) for the dashboard
    stopped.ts            SIGINT → stopped (indeterminate) verdict; errors.ts staged run-error stages
  agents/               per-Coding-Agent provisioning (resolveAgent dispatch)
    index.ts              agent registry + dispatch (incl. the inline Claude/Default adapters)
    command-runner.ts     injectable subprocess seam (live CLIs faked in tests)
    <agent>.ts            codex/gemini/kimi/opencode/pi/copilot/antigravity adapters
  normalizers/          session-log → normalized tool-call trace, one module per dialect
  capture/              session-log snapshot/diff + tool-call capture + token usage; cwd-filter
  obol/                 obol cost estimation (session-log + gauntlet sidecar)
  economics.ts          token-cost composition → coding-agent-token-usage.json
  composer.ts           three-valued verdict from the gauntlet + checks layers
  checks/               sources prelude.sh + checks.sh, runs pre()/post(), collects check records
    prelude.sh            bare-verb DSL: defines each check verb as a bash function that
                          delegates to the TS dispatchers (no bin/ shims, no PATH prepend)
  scheduler/            central concurrency dispatcher (one global slot pool, per-harness limits + spacing)
  run-all/              scenario × Coding-Agent matrix over the scheduler; batch index
  dashboard/            web matrix UI: read-side scan/view, typed HTML templates, SSE bus, orchestrator, Bun.serve
  setup-helpers/        scenario fixture builders + the `setup-helpers` CLI (dispatch registry)
  contracts/            zod schemas at the JSON boundaries (verdict, batch, economics, gauntlet, agent-config)
  scaffold.ts           `quorum new` / `quorum check`
  setup-step.ts         runs scenario setup.sh (sources prelude.sh via BASH_ENV so bare verbs resolve)
  story-meta.ts         story.md frontmatter (quorum_max_time, quorum_tier, status)
  env.ts                the single process.env boundary
  paths.ts              repo root, UTC stamps, nonces
  invariant.ts          assertNever exhaustiveness guard for closed unions
  check/                typed check verbs: fs-verbs.ts (file/git/env + bootstrap),
                        dispatch.ts (table + `not`), transcript-dispatch.ts, record.ts (sole emitter)
  cli/check-tool.ts     the dispatcher behind every check verb function (file-exists,
                        file-contains, command-succeeds, git-*, assert-checkout-clean,
                        requires-tool, not, files-exist, the *-installed/hook/extension
                        checks); check-transcript.ts and setup-helpers/cli.ts are the
                        other two dispatchers the prelude delegates to
  cli/list-check-verbs.ts  prints the FS_VERBS verb set the prelude loops over (drift-proof)
scripts/                operator scripts: run-with-log
coding-agents/          per-Coding-Agent material:
  <name>.yaml             CLI config
  <name>-context/         HOWTO prose for the Gauntlet-Agent
scenarios/              scenarios (one directory each)
fixtures/               shared static fixture repos (e.g. template-repo/, sdd-*/)
test/                   bun test suite
docs/                   design notes, specs, plans, testing protocols, baselines
```

## Triage

Triaging a non-passing run: `bun run quorum show [<target>]` and see
[docs/superpowers/skills/triaging-a-failing-eval.md](docs/superpowers/skills/triaging-a-failing-eval.md)
for the attribution atlas.

For the current known-good baseline (what counts as a clean batch on
this commit, per backend), see [docs/baselines/](docs/baselines/).

### Antigravity Troubleshooting

When an Antigravity run is non-passing or indeterminate:

1. Confirm `agy` is installed and reachable: `agy --version`.
2. Confirm local browser/keyring auth works outside quorum with a one-shot
   print command, for example `agy --print "Reply with EXACTLY OK."`.
3. Inspect the CLI lifecycle log at `<run>/home/agy.log`.
4. Confirm the plugin files exist under
   `<run>/home/.gemini/config/plugins/superpowers/`.
5. Confirm raw transcripts exist under
   `<run>/home/.gemini/antigravity-cli/brain/**/transcript.jsonl`.
6. Inspect normalized behavior in `<run>/trajectory.json`; plugin
   files alone do not prove hook or skill behavior.
7. Render the verdict with `bun run quorum show <run-or-batch-id>`.
8. For broad sweep triage, classify failures with
   [docs/baselines/antigravity-sweeps/README.md](docs/baselines/antigravity-sweeps/README.md).

### OpenCode Troubleshooting

When an OpenCode run is non-passing or indeterminate:

1. Confirm `opencode` is installed and reachable: `opencode --version`.
2. Confirm provider auth works outside quorum with a one-shot command, for
   example `opencode run --dangerously-skip-permissions "Reply with EXACTLY OK."`.
3. Confirm the staged plugin exists at
   `<run>/home/.config/opencode/plugins/superpowers.js`.
4. Confirm the staged skills exist under
   `<run>/home/.config/opencode/superpowers/skills/`.
5. Inspect the export manifest at
   `<run>/home/.quorum/session-exports/opencode-session-export-manifest.json`.
6. Inspect normalized behavior in `<run>/trajectory.json`; plugin
   files alone do not prove hook or skill behavior.
7. Render the verdict with `bun run quorum show <run-or-batch-id>`.

### Pi Troubleshooting

When a Pi run is non-passing or indeterminate:

1. Confirm `pi` is installed and reachable: `pi --version`.
2. Confirm `pi-subagents` is installed: `ls "$(npm root -g)/pi-subagents"`.
   The launcher exits 1 with `pi-subagents not found` when it is missing;
   fix with `npm install -g pi-subagents`.
3. Confirm `PI_PROVIDER`, `PI_MODEL`, `PI_API_KEY`, and `SUPERPOWERS_ROOT` are
   set in the shell that launches quorum.
4. If using `azure-openai-responses`, confirm `AZURE_OPENAI_BASE_URL` or
   `AZURE_OPENAI_RESOURCE_NAME` is set.
5. Inspect `<run>/home/.pi/agent/pi.env`; it should exist, be chmod
   `0600`, and contain the runtime env expected by the launcher.
6. Inspect `<run>/home/.pi/agent/auth.json`; it should be chmod `0600`
   and should reference `$PI_API_KEY`, not the literal secret.
7. Confirm raw Pi sessions exist under
   `<run>/home/.pi/agent/sessions/**/*.jsonl`.
8. If the verdict says `qa-agent-misconfigured`, look for a new Pi session
   whose header `cwd` is outside `<run>/coding-agent-workdir`.
9. If the verdict says `unusable Pi session header`, inspect the first line of
   each new Pi session for malformed JSON or missing `cwd`.
10. Inspect normalized behavior in `<run>/trajectory.json`.
11. Render the verdict with `bun run quorum show <run-or-batch-id>`.

### Copilot Troubleshooting

When a Copilot run is non-passing or indeterminate:

1. Confirm `copilot` is installed and reachable: `copilot --version`.
2. Confirm auth is available from `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
   `GITHUB_TOKEN`, `gh auth token`, or `COPILOT_PROVIDER_BASE_URL`.
3. Confirm the staged plugin files exist under
   `<run>/home/.copilot/plugins/superpowers/`.
4. Confirm the expected session-state trace exists at
   `<run>/home/.copilot/session-state/<run-session-id>/events.jsonl`.
5. Inspect normalized behavior in `<run>/trajectory.json`;
   behavioral validation comes from native `Skill` rows, not
   `copilot plugin list`.
6. If setup fails on a proxy variable, remove embedded credentials from the
   proxy URL and retry.
7. Render the verdict with `bun run quorum show <run-or-batch-id>`.

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
