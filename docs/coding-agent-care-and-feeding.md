# Coding-Agent Care And Feeding

Use this guide to run and triage the agent CLIs that quorum tests. For scenario
authoring, use [scenario-authoring.md](scenario-authoring.md). For adding a new
agent target, use [adding-a-coding-agent.md](adding-a-coding-agent.md).

Live evals are trusted-maintainer operations. They launch agent CLIs with broad
tool access and preserve raw transcripts, tool calls, filesystem state, and
run-local credential files under `results/`. Do not commit or paste raw run
artifacts without checking them first.

## Agent Matrix

| Coding-Agent | CLI | Required credentials |
| --- | --- | --- |
| `claude` | Claude Code | `ANTHROPIC_API_KEY`, `SUPERPOWERS_ROOT`; default credential: `opus` |
| `codex` | Codex CLI | `SUPERPOWERS_ROOT`; local ChatGPT subscription login via `codex login` |
| `antigravity` | Google Antigravity CLI, `agy` | `SUPERPOWERS_ROOT`; local browser/keyring auth |
| `gemini` | Gemini CLI, `gemini` | `GEMINI_API_KEY` or `GEMINI_AUTH_TYPE=oauth-personal`; `SUPERPOWERS_ROOT` |
| `hermes` | Hermes CLI | default credential `openrouter_glm_5_2` uses `OPENROUTER_API_KEY`; `SUPERPOWERS_ROOT` |
| `kimi` | Kimi Code | `KIMI_MODEL_API_KEY` or Kimi OAuth login; `SUPERPOWERS_ROOT` |
| `opencode` | OpenCode CLI | `SUPERPOWERS_ROOT`; provider credentials for the selected OpenCode model |
| `pi` | Pi CLI, `pi` | default credential `openrouter_glm_5_2` uses `OPENROUTER_API_KEY`; custom API-key auth uses `PI_PROVIDER`, `PI_MODEL`, and `PI_API_KEY`; Pi OAuth login remains opt-in; `SUPERPOWERS_ROOT` |
| `copilot` | GitHub Copilot CLI, `copilot` | `SUPERPOWERS_ROOT`, plus `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, GitHub CLI auth, or `COPILOT_PROVIDER_BASE_URL` |

To run the Claude harness against Sonnet or Haiku, use `--credential` (the
`claude-haiku` and `claude-sonnet` agent names were removed in favor of the
credential axis):

```bash
bun run quorum run scenarios/<name> --coding-agent claude --credential sonnet
bun run quorum run scenarios/<name> --coding-agent claude --credential haiku
bun run quorum run-all --coding-agents claude --credentials sonnet,haiku --jobs 2
```

Raw quorum runs require `SUPERPOWERS_ROOT` in the launching environment. The
container and appliance shims export `SUPERPOWERS_ROOT=/workspace/superpowers`
inside the runtime from their configured Superpowers checkout. For local
host-side runs, set it explicitly:

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
```

Use a different `SUPERPOWERS_ROOT` when running RED/GREEN comparisons against
modified Superpowers skill text.

## Shared Appliance

On a configured shared remote appliance where the Phase 1 helper is installed,
agents should use `evals-appliance`, not raw `bun run quorum ...` or raw
`scripts/evals-container exec quorum ...`. The appliance helper owns repo sync,
exact Superpowers ref resolution, the blessed credential bundle, locks, job
records, status, cancellation, and provenance.

Start with:

```bash
evals-appliance doctor --json
evals-appliance prepare --json --superpowers-ref <branch-tag-or-sha>
```

`doctor` is read-only. `prepare` resolves exact refs and returns `lock_busy`
instead of changing checkouts while an appliance live job is active.

Host access and provider-specific break-glass procedures are intentionally kept
out of this public repo. Use the private ops runbook when you need to connect to
the shared host.

Run the first sentinel batch detached:

```bash
evals-appliance run-all --json --detach \
  --superpowers-ref <branch-tag-or-sha> \
  -- --tier sentinel \
     --coding-agents claude,codex,kimi \
     --jobs 4
```

Recover and inspect with:

```bash
evals-appliance status --json <job-id>
evals-appliance show --json <job-id>
evals-appliance costs --json <job-id>
evals-appliance cancel --json <job-id>
```

Phase 1 appliance `run-all` is Linux-container-only. Antigravity and Windows
remain trusted-maintainer break-glass paths until the appliance explicitly
supports their auth and runtime preflights. See
[appliance-runbook.md](appliance-runbook.md) for the agent-facing workflow and
[2026-06-18-shared-eval-appliance-design.md](superpowers/specs/2026-06-18-shared-eval-appliance-design.md)
for the security and provenance contract.

## Credentials

In the container, put live eval credentials in `.env.container` or pass an
explicit file to `up`:

```bash
scripts/evals-container down || true
scripts/evals-container --env-file /path/to/evals.env up
```

The wrapper mounts the file read-only at `/run/evals/credentials.env`. It does
not pass the host environment wholesale. Only the in-container `quorum` shim
sources that dotenv file, so `scripts/evals-container exec bash ...` does not
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
  --coding-agents claude,codex,kimi \
  --jobs 4

for agent in gemini opencode pi copilot; do
  scripts/evals-container exec quorum run-all \
    --tier sentinel \
    --coding-agents "$agent" \
    --jobs 1
done
```

Run the same commands without `--tier sentinel` for the full ready suite.
`run-all` writes each batch under `results/batches/<batch-id>/` and each run
under `results/<scenario>-<agent>-<os>-<timestamp>-<nonce>/`; render a batch
with:

```bash
scripts/evals-container exec quorum show <batch-id>
```

Leave Antigravity out of the container sweep for now. The image ships no
headless `agy` install path, so Antigravity remains host-side.

## Host-Side Sweeps

For all-harness trusted-maintainer sweeps, `--jobs` is the global live-cell cap
within one `run-all` process, with per-agent caps and launch spacing layered
inside that pool. Separate `run-all` processes still need operator discipline or
host-level appliance locks.

Prefer grouped batches:

```bash
set -a; source .env; set +a
export SUPERPOWERS_ROOT=/path/to/superpowers
export GEMINI_AUTH_TYPE=oauth-personal
export SCENARIOS="scenario-a,scenario-b"

# Uncapped targets share the --jobs pool.
bun run quorum run-all \
  --coding-agents claude,codex,kimi \
  --scenarios "$SCENARIOS" \
  --jobs 4

# Capped or fragile targets run one serial column per batch. Launch several
# single-column batches in parallel only when their backends do not interfere.
bun run quorum run-all --coding-agents copilot --scenarios "$SCENARIOS" --jobs 1 &
bun run quorum run-all --coding-agents opencode --scenarios "$SCENARIOS" --jobs 1 &
bun run quorum run-all --coding-agents pi --scenarios "$SCENARIOS" --jobs 1 &
bun run quorum run-all --coding-agents gemini --scenarios "$SCENARIOS" --jobs 1 &
wait

# Keep Antigravity separate from Gemini to avoid Google/Gemini auth or quota
# noise while collecting clean capture.
bun run quorum run-all --coding-agents antigravity --scenarios "$SCENARIOS" --jobs 1
```

`run-all` persists results automatically; no `tee` or stdout capture is needed.
View results with `bun run quorum show <batch-id>`.

## Per-Agent Notes

### Claude

Claude targets seed `<run>/home/.claude` with project trust and API-key
approval. Recent Claude Code boots straight to the prompt on
`ANTHROPIC_API_KEY` plus that trust block, so quorum ships no committed Claude
home skeleton.

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

### Hermes

- **Auth:** OpenRouter API key only (`OPENROUTER_API_KEY`, via the
  `openrouter_glm_5_2` credential). No OAuth path is wired.
- **Config collapse:** everything under `<run>/home/.hermes/` — config.yaml,
  `.env` (0600), `plugins/superpowers/` (staged from `SUPERPOWERS_ROOT`),
  `logs/`.
- **Superpowers source:** provisioning requires `.hermes-plugin/plugin.yaml`,
  `.hermes-plugin/__init__.py`, `skills/using-superpowers/SKILL.md`, and
  `skills/using-superpowers/references/hermes-tools.md` in `SUPERPOWERS_ROOT`,
  and fails closed without them. Until that branch merges to superpowers dev,
  point `SUPERPOWERS_ROOT` at a `hermes-harness-rebase` checkout.
- **Known state:** the shipped plugin's `on_session_start` +
  `ctx.inject_message` mechanism is unverified against the documented plugin
  API; the bootstrap scenario's RED result on the unfixed plugin is the
  expected baseline, not a harness bug. See the design spec
  (2026-07-23-hermes-coding-agent-design.md).
- **Capture:** sessions are NOT files — they live in a SQLite store
  (`~/.hermes/state.db`). The runner (`src/agents/hermes-capture.ts`) exports
  each new session post-run via `hermes sessions list` +
  `hermes sessions export --format jsonl --session-id <id> -` into
  `<run>/home/.hermes/sessions-export/<id>.json`. Token/cost fields
  (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
  `reasoning_tokens`, `actual_cost_usd`) come embedded on the exported session
  object and fold into `final_metrics` (`normalizeHermes`,
  `src/normalize/hermes.ts`). If the current CLI's export layout drifts,
  fix the normalizer/capture module with a captured fixture — do not loosen
  the strict empty-trace failure.
- **Bundled skills library:** Hermes self-installs a large bundled skills tree
  under `<run>/home/.hermes/skills/` on first run. This is unrelated to the
  Superpowers plugin (staged separately at `<run>/home/.hermes/plugins/
  superpowers/`) — harmless, but it explains the large `.hermes/` tree.

### Antigravity

Antigravity runs host-side for now. The generated launcher pins the throwaway
home and runs `agy` with `--dangerously-skip-permissions` and an explicit
`--gemini_dir` under `<run>/home/.gemini`. quorum seeds host Gemini OAuth creds,
runs an isolated auth preflight, and installs the Superpowers plugin from
`SUPERPOWERS_ROOT`.

Antigravity auth uses local browser/keyring state owned by the maintainer
running the eval. It cannot run from environment-only CI credentials.

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

By default, Pi runs through the `openrouter_glm_5_2` credential in
`credentials.yaml`, so local and appliance runs need `OPENROUTER_API_KEY` in the
credential env. The adapter writes run-local `PI_PROVIDER`, `PI_MODEL`, and
`PI_API_KEY` from that credential; do not set those for the default path. For
raw/custom Pi env auth outside the credential axis, set `PI_PROVIDER`,
`PI_MODEL`, and `PI_API_KEY`. For `PI_PROVIDER=azure-openai-responses`, set
either `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`; quorum also
forwards optional `AZURE_OPENAI_API_VERSION` and
`AZURE_OPENAI_DEPLOYMENT_NAME_MAP`.

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
