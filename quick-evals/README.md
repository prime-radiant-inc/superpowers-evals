# Quick evals

Fast, local tools for tuning a skill's behavior before (or instead of) a
quorum run. They drive real Claude Code, Codex, and Pi sessions through
[claude-session-driver](https://github.com/obra/claude-session-driver) and
use your local logins, so an iteration takes minutes and no API keys. They
don't replace quorum: there is no Gauntlet-Agent verdict, no deterministic
checks, and you score the transcripts yourself (or with a scoring agent).

| Directory | What it covers |
|---|---|
| `brainstorming/` | Opening-message samples (`first-turn.sh`), full conversations against a simulated human with hidden intent (`converse.sh`, `scenarios/`), blind A/B pairs (`blind-pair.sh`), side-by-side arms (`matrix.sh`, `batch.sh`), and scorers (`gate-score.sh`, `tech-lines.sh`). Each script has `-h`. |

## Safety

Unlike quorum, these tools do **not** isolate the agent under test:

- Workers run with permissions bypassed (Codex runs sandboxed unless
  `CODEX_PERMISSIONS=yolo`), under your real `$HOME` and account identity.
  Test sessions have written to `~/Desktop` and used the operator's name.
- `converse.sh` adds a trust entry for each Claude run's work dir to your
  real `~/.claude.json` and removes it when the run ends.
- `codex-with-plugin.sh` turns off the account's connectors for Codex
  workers, so a test run can't send or publish as you.

Run them only on a machine and account where that's acceptable.

## Requirements

tmux, jq, the harness CLIs you drive (`claude`, `codex`, `pi`), and
claude-session-driver 4.0.1 or later with consent granted
(`csd grant-consent`). Point `CSD` at its `csd` script if it isn't at
`~/git/claude-session-driver`.
