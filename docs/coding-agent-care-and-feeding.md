# Coding-Agent Care And Feeding

This guide is for running and triaging the agent CLIs that quorum tests. For
scenario authoring, use [scenario-authoring.md](scenario-authoring.md). For
adding a new agent target, use [adding-a-coding-agent.md](adding-a-coding-agent.md).

Live evals are trusted-maintainer operations. They launch agent CLIs with broad
tool access and preserve raw transcripts, tool calls, filesystem state, and
run-local credential files under `results/`. Do not commit or paste raw run
artifacts without checking them first.

## Agent Matrix

| Coding-Agent | CLI | Required credentials |
| --- | --- | --- |
| `claude` | Claude Code | `ANTHROPIC_API_KEY`, `SUPERPOWERS_ROOT` |
| `claude-haiku` | Claude Code, Haiku target | `ANTHROPIC_API_KEY`, `SUPERPOWERS_ROOT` |
| `claude-sonnet` | Claude Code, Sonnet target | `ANTHROPIC_API_KEY`, `SUPERPOWERS_ROOT` |
| `codex` | Codex CLI | `SUPERPOWERS_ROOT`; local ChatGPT subscription login via `codex login` |
| `antigravity` | Google Antigravity CLI, `agy` | `SUPERPOWERS_ROOT`; local browser/keyring auth |
| `gemini` | Gemini CLI, `gemini` | `GEMINI_API_KEY` or `GEMINI_AUTH_TYPE=oauth-personal`; `SUPERPOWERS_ROOT` |
| `kimi` | Kimi Code | `KIMI_MODEL_API_KEY` or Kimi OAuth login; `SUPERPOWERS_ROOT` |
| `opencode` | OpenCode CLI | `SUPERPOWERS_ROOT`; provider credentials for the selected OpenCode model |
| `pi` | Pi CLI, `pi` | `PI_PROVIDER`, `PI_MODEL`, and `PI_API_KEY`, or Pi OAuth login; `SUPERPOWERS_ROOT` |
| `copilot` | GitHub Copilot CLI, `copilot` | `SUPERPOWERS_ROOT`, plus `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, GitHub CLI auth, or `COPILOT_PROVIDER_BASE_URL` |

`claude-haiku` and `claude-sonnet` are Claude Code target variants. They use the
same Claude runtime, context, and `ANTHROPIC_API_KEY` path as `claude`.

When this repo is checked out as `superpowers/evals`, quorum defaults
`SUPERPOWERS_ROOT` to the parent `superpowers` checkout. In a standalone
`superpowers-evals` clone, set it explicitly:

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
```

Use a different `SUPERPOWERS_ROOT` when running RED/GREEN comparisons against
modified Superpowers skill text.

## Credentials

In the container, put live eval credentials in `.env.container` or pass an
explicit file to `up`:

```bash
scripts/evals-container down || true
scripts/evals-container --env-file /path/to/evals.env up
```

The wrapper mounts the file read-only at `/run/evals/credentials.env`. The host
environment is not passed wholesale. Only the in-container `quorum` shim sources
that dotenv file, so `scripts/evals-container exec bash ...` does not
automatically receive live eval credentials.

OAuth/file auth directories are also mounted read-only:

| Source | Default host path | Container path | Override |
| --- | --- | --- | --- |
| Codex | `~/.codex` | `/auth/codex` | `--auth codex=<dir>` |
| Gemini / Antigravity | `~/.gemini` | `/auth/gemini` | `--auth gemini=<dir>` |
| Kimi | `~/.kimi-code` | `/auth/kimi-code` | `--auth kimi=<dir>` |
| Pi | `~/.pi` | `/auth/pi` | `--auth pi=<dir>` |

Use `down` before changing an env-file or auth mount on an existing container.

For local host-side runs, source the credentials in the shell that launches
`bun run quorum ...`. Keep that shell narrow: export only the credentials needed
for the selected agents.

## Container Sweeps

Build, start, and validate the container first:

```bash
scripts/evals-container build
scripts/evals-container down || true
scripts/evals-container --env-file .env.container up
scripts/evals-container exec evals-tool-versions
scripts/evals-container exec quorum check
```

Start with the sentinel suite:

```bash
scripts/evals-container exec quorum run-all \
  --tier sentinel \
  --coding-agents claude,claude-haiku,claude-sonnet,codex,kimi \
  --jobs 4 \
  --no-cursor

for agent in gemini opencode pi copilot; do
  scripts/evals-container exec quorum run-all \
    --tier sentinel \
    --coding-agents "$agent" \
    --jobs 1 \
    --no-cursor
done
```

Run the same commands without `--tier sentinel` for the full ready suite.
`run-all` writes each batch under `results/batches/<batch-id>/` and each run
under `results/<scenario>-<agent>-<timestamp>-<nonce>/`; render a batch with:

```bash
scripts/evals-container exec quorum show <batch-id>
```

Do not include Antigravity in the container sweep yet. The image does not ship a
headless `agy` install path, so Antigravity remains host-side.

## Host-Side Sweeps

For all-harness trusted-maintainer sweeps, do not put every Coding-Agent in one
`run-all --jobs N` command when you need a hard global concurrency cap. Agents
with `max_concurrency: 1` in `coding-agents/*.yaml` run in dedicated lanes beside
the shared `--jobs` pool, so one broad batch can exceed `N` live cells.

Prefer grouped batches:

```bash
set -a; source .env; set +a
export SUPERPOWERS_ROOT=/path/to/superpowers
export GEMINI_AUTH_TYPE=oauth-personal
export SCENARIOS="scenario-a,scenario-b"

# Uncapped targets share the --jobs pool.
bun run quorum run-all \
  --coding-agents claude,claude-haiku,claude-sonnet,codex,kimi \
  --scenarios "$SCENARIOS" \
  --jobs 4 \
  --no-cursor

# Capped or fragile targets run one serial column per batch. Launch several
# single-column batches in parallel only when their backends do not interfere.
bun run quorum run-all --coding-agents copilot --scenarios "$SCENARIOS" --jobs 1 --no-cursor &
bun run quorum run-all --coding-agents opencode --scenarios "$SCENARIOS" --jobs 1 --no-cursor &
bun run quorum run-all --coding-agents pi --scenarios "$SCENARIOS" --jobs 1 --no-cursor &
bun run quorum run-all --coding-agents gemini --scenarios "$SCENARIOS" --jobs 1 --no-cursor &
wait

# Keep Antigravity separate from Gemini to avoid Google/Gemini auth or quota
# noise while collecting clean capture.
bun run quorum run-all --coding-agents antigravity --scenarios "$SCENARIOS" --jobs 1 --no-cursor
```

`run-all` persists results automatically; no `tee` or stdout capture is needed.
View results with `bun run quorum show <batch-id>`.

## Per-Agent Notes

### Claude

Claude targets seed `<run>/home/.claude` with project trust and API-key
approval. Recent Claude Code boots straight to the prompt on
`ANTHROPIC_API_KEY` plus that trust block, so quorum does not ship a committed
Claude home skeleton.

Smoke:

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
export ANTHROPIC_API_KEY=...
bun run quorum run scenarios/00-quorum-smoke-hello-world --coding-agent claude
```

### Codex

Codex seeds `<run>/home/.codex` from the operator's local ChatGPT subscription
login at `~/.codex/auth.json`, or from `/auth/codex` in the container. Keep the
host login current with `codex login`. Codex runs use
`--dangerously-bypass-approvals-and-sandbox`; do not wire live Codex evals to
public CI.

### Gemini

Gemini's config dir is collapsed onto the throwaway home. quorum seeds
`<run>/home/.gemini`, writes a chmod-0600 runtime env file for API-key auth, and
links Superpowers from `SUPERPOWERS_ROOT` with:

```bash
gemini extensions link "$SUPERPOWERS_ROOT" --consent
```

By default, set `GEMINI_API_KEY`. For a trusted OAuth run, set
`GEMINI_AUTH_TYPE=oauth-personal`; quorum copies `oauth_creds.json` and
`google_accounts.json` from `GEMINI_OAUTH_HOME`, `/auth/gemini`, or `~/.gemini`
into the isolated run home.

Useful evidence:

```text
<run>/home/.gemini/extensions/superpowers/.gemini-extension-install.json
<run>/home/.gemini/extensions/extension-enablement.json
<run>/home/.gemini/extension_integrity.json
<run>/home/.gemini/tmp/**/chats/**/*.json*
<run>/trajectory.json
```

Extension files prove linking. Behavioral evidence comes from `trajectory.json`
and the raw Gemini transcripts.

### Antigravity

Antigravity runs host-side for now. The generated launcher pins the throwaway
home and runs `agy` with `--dangerously-skip-permissions` and an explicit
`--gemini_dir` under `<run>/home/.gemini`. quorum seeds host Gemini OAuth creds,
runs an isolated auth preflight, and installs the Superpowers plugin from
`SUPERPOWERS_ROOT`.

Antigravity auth is local browser/keyring state owned by the maintainer running
the eval. It is not an environment-only CI credential model.

Useful evidence:

```text
<run>/home/.gemini/config/plugins/superpowers/
<run>/home/.gemini/antigravity-cli/brain/**/transcript.jsonl
<run>/home/agy.log
<run>/trajectory.json
```

Plugin files prove installation. Behavioral evidence comes from `trajectory.json`
and raw Antigravity transcripts.

### Kimi

Kimi seeds config and host OAuth under `<run>/home/.kimi-code`. It does not read
or symlink the host's `~/.kimi-code`. API-key auth comes from
`KIMI_MODEL_API_KEY`; `KIMI_MODEL_NAME` is the only allowed host `KIMI_MODEL_*`
override for reproducibility.

Kimi runs use the image or host `kimi` binary with `--yolo`. Raw wire logs can
contain model outputs, tool arguments, and provider environment:

```text
<run>/home/.kimi-code/sessions/**/wire.jsonl
<run>/trajectory.json
```

Do not run Kimi evals against untrusted PR scenarios until tool-subprocess env
scrubbing has been verified.

### OpenCode

OpenCode's config dir is collapsed onto the throwaway home. quorum stages the
local Superpowers OpenCode plugin and skills under the home's XDG dirs, pins
`OPENCODE_CONFIG_DIR=<home>/.config/opencode`, and runs:

```bash
opencode run -i --dangerously-skip-permissions
```

Before launch, quorum runs a provider preflight:

```bash
opencode run --dangerously-skip-permissions "Reply with EXACTLY OK."
```

OpenCode stores sessions outside simple JSON transcript files, so quorum
snapshots `opencode session list --format json`, exports matching new sessions,
and normalizes the exported files under:

```text
<run>/home/.quorum/session-exports/[0-9]*-ses_*.json
<run>/home/.quorum/session-exports/opencode-session-export-manifest.json
<run>/trajectory.json
```

### Pi

Pi seeds run-local auth, settings, and env files under
`<run>/home/.pi/agent`:

```text
<run>/home/.pi/agent/auth.json
<run>/home/.pi/agent/settings.json
<run>/home/.pi/agent/pi.env
<run>/home/.pi/agent/sessions/**/*.jsonl
```

For API-key auth, set `PI_PROVIDER`, `PI_MODEL`, and `PI_API_KEY`. For
`PI_PROVIDER=azure-openai-responses`, set either `AZURE_OPENAI_BASE_URL` or
`AZURE_OPENAI_RESOURCE_NAME`; quorum also forwards optional
`AZURE_OPENAI_API_VERSION` and `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`.

The launcher loads Superpowers from `SUPERPOWERS_ROOT` and the global
`pi-subagents` package. If `pi-subagents` is missing, install it with:

```bash
npm install -g pi-subagents
```

### Copilot

Copilot seeds `<run>/home/.copilot`, writes a chmod-0600 `.copilot-env`, stages
Superpowers under `<run>/home/.copilot/plugins/superpowers`, and launches with
`--allow-all`, `--no-auto-update`, `--no-remote`, and
`--disable-builtin-mcps`.

Auth can come from `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`,
`gh auth token`, or `COPILOT_PROVIDER_BASE_URL`. Proxy URLs with embedded
credentials are rejected; remove userinfo from `HTTP_PROXY`, `HTTPS_PROXY`,
`ALL_PROXY`, and lowercase variants before running Copilot evals.

Copilot's primary trace is strict session state:

```text
<run>/home/.copilot/session-state/<run-session-id>/events.jsonl
<run>/trajectory.json
```

Do not use `copilot plugin list` as the validation source; currently it reports
no plugins for the staged root. Behavioral validation comes from native `Skill`
rows in `trajectory.json`.

## Troubleshooting

Start every non-passing run with:

```bash
bun run quorum show <run-or-batch-id>
```

Then use [superpowers/skills/triaging-a-failing-eval.md](superpowers/skills/triaging-a-failing-eval.md)
for the attribution atlas.

For agent-specific failures:

- Antigravity: confirm `agy --version`, confirm `agy --print "Reply with EXACTLY OK."`, inspect `<run>/home/agy.log`, plugin files, raw transcripts, and `trajectory.json`.
- OpenCode: confirm `opencode --version`, confirm provider auth with the one-shot preflight, inspect staged plugin files, the session export manifest, and `trajectory.json`.
- Pi: confirm `pi --version`, confirm `pi-subagents` exists under `npm root -g`, inspect `pi.env`, `auth.json`, raw sessions, and `trajectory.json`.
- Copilot: confirm `copilot --version`, confirm auth source availability, inspect staged plugin files, expected session-state events, and `trajectory.json`.
- Gemini: inspect extension files, raw chats, and `trajectory.json`; extension linking alone is not behavior.
- Kimi: inspect the local-path plugin entry, raw `wire.jsonl`, and `trajectory.json`; treat raw wire logs as sensitive.
