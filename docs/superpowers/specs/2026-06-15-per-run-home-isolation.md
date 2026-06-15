# Design: Per-Run Throwaway `$HOME` for Quorum Eval Runs

> Status: design (2026-06-15). Jesse: "we're going to eventually need to at least set a custom `$HOME` for every single eval run." Implementation is phased; this doc is the plan + decision record. Authored from a read-only code survey (Bun ≥1.3).

## 1. Goal

Every quorum eval run should give the agent-under-test (and ideally the gauntlet drive) a **throwaway `$HOME`** rooted under the run directory, so neither the Coding-Agent nor the Gauntlet-Agent reads/writes the operator's real home-relative global state (`~/.gemini`, `~/.codex`, `~/.claude`, `~/.config`, `~/.cache`, OS keychain, XDG dirs). This makes runs hermetic and removes a class of leakage/non-determinism bugs (host gemini/agy state bleeding in, personal plugins/skills leaking into runs, host caches polluting timing/cost).

Central tension: **agents authenticate from the real home** (`~/.codex/auth.json`, `~/.gemini/oauth_creds.json`, agy keyring/`~/.gemini`), so a throwaway `$HOME` must not sever auth. The work is read-real-creds / write-isolated, plus closing the gap on the agents that currently leave `$HOME` untouched.

## 2. Current state

No global `$HOME` override exists today. `src/runner/index.ts` `spawnGauntlet` (~270-298) builds the gauntlet env as `{ ...(envBase ?? envSnapshot()), QUORUM_AGENT_CWD, ...extraEnv }` — never sets `HOME`. Isolation is split, applied unevenly:

| Agent | Pins `HOME` for the agent? | Where | XDG pinned? |
|---|---|---|---|
| **codex** | Yes | `codex-context/launch-agent:41` | Yes (:42-46) |
| **copilot** | Yes | `copilot-context/launch-agent:42` (`env -i … HOME=$COPILOT_HOME_SH`) | partial |
| **opencode** | Yes | `opencode-context/launch-agent:28` + `opencodeEnv()` (`opencode-capture.ts:44-54`) | Yes |
| **kimi** | Yes (via sourced env file) | `kimi.ts:604` → `kimi-runtime.env`, sourced by `kimi-context/launch-agent:16` | Yes (:607-609) |
| **claude** | **No** | `claude-context/launch-agent:29` sets `CLAUDE_CONFIG_DIR` only | No |
| **gemini** | **No** | `gemini-context/launch-agent:11-15` sets `GEMINI_CLI_HOME` only | No |
| **antigravity** | **No** | `antigravity-context/launch-agent:15-23` (`ANTIGRAVITY_CONFIG_DIR` + `--gemini_dir`) | No |
| **pi** | **No** | `pi-context/launch-agent:29-44` (`PI_CODING_AGENT_DIR`) | No |

The codex launcher carries the rationale (`codex-context/launch-agent:15-24`): Codex's core-skills loader adds `$HOME/.agents/skills` via `home_dir()` with no off switch, so a host `~/.agents/skills/superpowers` overrides the staged plugin-under-test. That is the leakage class a throwaway `$HOME` closes for ALL agents.

**Auth-seeding escape hatches already present:** codex reads `CODEX_AUTH_HOME ?? ~/.codex` (`codex.ts:187`) and copies `auth.json` into the per-run `CODEX_HOME`; gemini reads `GEMINI_OAUTH_HOME ?? ~/.gemini` (`gemini.ts:151`) and copies oauth creds. Remaining real-home auth reads: antigravity/agy (`agy-creds.ts:22` `~/.gemini/oauth_creds.json` + keyring), copilot `gh auth token` (reads gh config under `$HOME`/`XDG_CONFIG_HOME`, `copilot.ts:259-269`). kimi/pi/copilot-provider/claude are env-var/file auth (not home-relative).

Setup/gauntlet subprocesses (`setup-step.ts:30-45`, `command-runner.ts`, gemini/agy provisioning) currently run at the real `$HOME`. obol (in-process lib) + capture read no home state.

## 3. Load-bearing runtime fact: `os.homedir()` vs `$HOME`

Verified on Bun ≥1.3: **Bun `os.homedir()` snapshots `$HOME` at startup and ignores a mid-process `process.env.HOME` mutation**; Node's `os.homedir()` *does* reflect it. Consequences:

1. The two existing "homedir() ignores a mid-process $HOME change" comments are correct **for Bun** — quorum's own `homedir()` reads (codex/gemini/agy-creds/antigravity/agent-config) keep resolving the REAL operator home even if quorum mutated its own `$HOME`. So quorum-internal auth reads stay anchored to the real home for free.
2. Correct lever = **per-subprocess `env.HOME`**, never `setProcessEnv('HOME', …)` on quorum itself (ineffective for `homedir()` on Bun + dangerous on a future Node port).
3. For safety on a future Node port, capture `const REAL_HOME = homedir()` once at startup (or always use the `*_AUTH_HOME`/`*_OAUTH_HOME` overrides) for credential-source reads.

## 4. Per-agent home-state inventory (R/W, file:line)

Net gaps currently at real `$HOME`: claude/gemini/antigravity/pi agent launchers; gemini/antigravity provisioning subprocesses; the gauntlet drive; setup.sh. Already isolated: codex/copilot/opencode/kimi agent launchers. (Full table in the survey; key auth reads: `codex.ts:187`, `gemini.ts:151`, `agy-creds.ts:22`, `copilot.ts:259-269`.)

## 5. Auth-seeding strategy

- **A. File-copied-from-real-home (codex, gemini-oauth):** already solved + Bun-safe; no change to the copy. Policy: credential-source reads must use the `*_AUTH_HOME`/`*_OAUTH_HOME` override or a startup `REAL_HOME` constant, never a post-relocation `$HOME`.
- **B. Env-var/file auth (claude, kimi, pi, copilot-provider):** not home-relative; throwaway `$HOME` is transparent. Just don't displace the pinned config-dir vars.
- **C. Live-token/keyring (antigravity/agy) — the hard case:** agy reads a live, rotating OAuth token from `~/.gemini/oauth_creds.json` at runtime + a keyring entry. Options:
  - **C1:** seed `~/.gemini/oauth_creds.json`+`google_accounts.json` into throwaway `$HOME/.gemini` (via a new `AGY_OAUTH_HOME`), like gemini-oauth. Risk: token rotation → staleness + refresh lands in throwaway home, not real `~/.gemini`.
  - **C2 (recommended phase 1):** exempt antigravity from throwaway `$HOME` (keyring isn't home-relative; `--gemini_dir` already isolates state; residual is a read-mostly token). **Decision needed: C1 vs C2.**
- **copilot `gh auth token`:** runs during provisioning at quorum's env BEFORE any agent `$HOME`. Keep that call at real `$HOME` (host-trust read); resolved token written to `.copilot-env`; agent launcher already `env -i HOME=$COPILOT_HOME`. No change.

## 6. Wiring points

- **W1** allocate `const runHomeDir = join(runDir, 'home')` + mkdir in `runInnerBody` (`runner/index.ts` ~965-976). Run-dir-relative (captured, reaped with the run) — not mkdtemp (would need `runtimeCleanupDirs`).
- **W2** gauntlet env: add `HOME: runHomeDir` (+ XDG/TMPDIR) to `spawnGauntlet` BETWEEN base and `extraEnv` (so opencode's `extraEnv.HOME` still wins). Isolates the Gauntlet-Agent CLI.
- **W3** agent launchers: add `HOME="$QUORUM_AGENT_HOME"` (+XDG/TMPDIR) to claude/gemini/pi launchers (antigravity only if C1).
- **W4** new substitutions `$QUORUM_AGENT_HOME` / `_SH` in `runner/index.ts` substitutions map (~1100), like `$QUORUM_AGENT_CWD`.
- **W5** provisioning subprocesses (gemini `extensions link`, agy `plugin install`/preflight, codex `app-server`): overlay `HOME: runHomeDir` — thread via a new `RunHome.homeDir` field (`src/agents/index.ts:24-31`).
- **W6** setup.sh env: overlay `HOME: runHomeDir` — phase LAST (fixtures need host tool caches `~/.cache/uv`, `~/.bun`; isolating forces re-download).

## 7. Interaction with config-dir envs

Throwaway `$HOME` **complements**, never replaces, the per-agent config-dir vars (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `ANTIGRAVITY_CONFIG_DIR`, `KIMI_CODE_HOME`, `COPILOT_HOME`, `OPENCODE_QUORUM_HOME`, `PI_CODING_AGENT_DIR`). Set `HOME` before the config-dir var + before `extraEnv`. Those vars are absolute paths under the run dir, independent of `$HOME`. `session_log_dir` `~` expansion (`agent-config.ts:148-156`) is dormant (no YAML uses `~`); when introducing the home, expand `~`→`runHomeDir` for the agent-facing log path (guard + test).

## 8. Risks

1. **agy auth breakage (highest)** — exempt antigravity (C2) phase 1; never ship a global `$HOME` covering agy without the seed.
2. **Bun↔Node `homedir()` divergence** — capture `REAL_HOME` at startup; test credential source resolves to real home.
3. **Fixture cache re-download under isolated setup.sh** — phase 3 / opt-in / pre-seed caches.
4. **`gh auth token` under relocated `$HOME`** — keep provisioning `gh` at real `$HOME`.
5. **Double-set `HOME`** (opencode/kimi/codex/copilot already pin) — composition order: base `HOME` overridable by `extraEnv`/launcher.
6. **Test fragility** — `test/agent-opencode*` mutate `process.env.HOME`; new env-composition needs unit coverage that `extraEnv.HOME` wins.
7. **Cleanup** — run-dir-relative `home/` reaped naturally.

## 9. Phased plan

- **Phase 0** land this spec; get C1-vs-C2 call on antigravity; `docs/experiments/` entry.
- **Phase 1** close the four un-pinned agent launchers (claude/gemini/pi; exempt antigravity), behind a flag (`QUORUM_ISOLATE_HOME=1` or per-agent YAML key). Smallest change, largest leak closed.
- **Phase 2** gauntlet drive (W2) + provisioning subprocesses (W5, via `RunHome.homeDir`) + `REAL_HOME` constant + `session_log_dir` `~` guard.
- **Phase 3** setup.sh isolation (optional, with cache strategy).
- **Phase 4** antigravity C1 (optional; validate token-rotation window).
- **Phase 5** flip flag default on; update `*-context/HOWTO.md`.

## 10. Test strategy

Unit (hermetic): `spawnGauntlet` env composition (`HOME=runHomeDir`; opencode `extraEnv.HOME` wins; XDG present); launcher substitution (installed claude/gemini/pi launchers contain literal `runHomeDir`); credential-source anchoring (mutate `process.env.HOME` mid-test, assert codex/gemini reads still hit real home / override); `RunHome.homeDir` threading (via fake `CommandRunner`); negative (throwaway `$HOME` doesn't displace config-dir vars). Live (trusted-maintainer): per-agent smoke with `QUORUM_ISOLATE_HOME=1` vs flag-off parity; a planted `~/.agents/skills/canary` host marker must NOT appear in the agent's loaded skills (directly tests the closed leak class). `bun run check` + `bun run quorum check` stay green.

### Bottom line
Architecture already supports this — 3/8 agents pin `HOME`; 2 adapters pre-built `*_AUTH_HOME`/`*_OAUTH_HOME`. Work: (1) close the four un-pinned launchers, (2) add `HOME` to gauntlet + provisioning subprocess env, (3) keep credential reads anchored to the REAL home (free on Bun; explicit constant for safety), (4) treat **antigravity/agy as the one hard case** (live token + keyring) — exempt first, seed later. Never `setProcessEnv('HOME')` on quorum itself.
