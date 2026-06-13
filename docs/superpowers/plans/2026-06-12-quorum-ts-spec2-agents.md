# Quorum TS — Spec 2: Normalizer & Agent Fan-out — Implementation Plan

> **For agentic workers:** built by concurrent worktree Bobs. Each task is gated by `bun run check` (Biome 2.x ci + `tsc --noEmit` full-strict + scoped `bun test`) and follows the coding standard `docs/superpowers/specs/2026-06-12-typescript-coding-standard.md`.

**Goal:** Bring the 7 remaining coding agents to capture/normalize + provisioning parity with the Python, so `quorum run … --coding-agent <codex|kimi|gemini|pi|opencode|copilot|antigravity>` works. Builds on Spec 1 (PRI-2207, PR #13).

**Architecture:** Each agent = (a) a **normalizer** `src/normalizers/<agent>.ts` following the proven `src/normalizers/claude.ts` template (JSON.parse → `unknown` → narrow with permissive zod → emit `{tool, args, source}`), registered in `src/normalizers/index.ts`; and (b) a **provisioning adapter** in `src/agents/` — `DefaultAgent` (YAML-only) for the simple ones, a custom `CodingAgent` for the rest — resolved by `resolveAgent`. Parity is proven per-agent by a **replay-differential test** against a real recorded run mined from `results/` (the Spec-1 oracle pattern: pick a single-session run so one file's normalization equals the committed `coding-agent-tool-calls.jsonl`).

**Source of truth:** `quorum/normalizers.py` (per-dialect normalize fns + `TOOL_MAP`s + `NATIVE_TOOLS`), `quorum/capture.py` (cwd-filtering), `quorum/runner.py` (provisioning), `quorum/kimi.py`, `quorum/opencode_capture.py`, `quorum/agy_{watch,creds,teardown}.py`, `coding-agents/<agent>.yaml`. Each builder reads the Python for exact logic.

---

## Build waves

**Wave A — 7 normalizers (fully parallel, one Bob each).** Each Bob creates `src/normalizers/<agent>.ts` + a replay test `test/replay-<agent>.test.ts` + its mined fixture under `test/fixtures/<agent>/`. **Does NOT touch `src/normalizers/index.ts`** (shared registry — the integrator wires all 7 entries at once to avoid conflicts). Normalizers are pure and independently testable against recorded fixtures — no provisioning needed yet.

**Wave B — provisioning adapters.** `src/agents/` adapters, resolved via `resolveAgent`. The agents registry (`src/agents/index.ts`) is shared, so these are more coupled — sequence the simple ones, dedicate Bobs to the hard ones. Split:
- **Declarative-ish (DefaultAgent or thin adapter):** gemini (extension link), pi (config.json/settings.json gen).
- **Login/stage ceremonies:** codex (`codex login --with-api-key` + plugin hooks), copilot (`COPILOT_HOME` staging + `--plugin-dir` + env allowlist).
- **Custom adapters (hard):** opencode (session export via `opencode` CLI + XDG isolation), kimi (auth/sentinel/home protocol — the hardest), antigravity (rate-limit watcher + OAuth creds backup/restore + tmux teardown).

**Wave C — registry + runner integration.** Wire all 7 normalizers into `NORMALIZERS`, all 7 adapters into `resolveAgent`, add cwd-filtering to capture (codex/kimi/pi filter new logs by recorded cwd), and the antigravity rate-limit → `indeterminate` path in the runner. Then a per-agent smoke via mock-gauntlet where feasible.

---

## Per-agent normalizer specs (Wave A)

All emit `ToolCall = {tool, args, source}`; `source` = `native` iff canonical tool ∈ the global `NATIVE_TOOLS` set (already in `claude.ts` — import/extend it, don't redefine). Skip blank/malformed lines. Read the Python for byte-exact logic.

| agent | difficulty | key divergences from claude (read `normalizers.py`) |
|---|---|---|
| **codex** | moderate | entries are `{type:'response_item', payload:…}`; dispatch on `payload.type`: `function_call` (args = JSON-parsed `arguments`, fallback `{raw}`), `custom_tool_call` (args = raw `input`), `local_shell_call` (`action.command` array/str → join). `CODEX_TOOL_MAP = {spawn_agent: Agent}`; `exec_command→Bash` (args `{command: cmd}`), `apply_patch→Edit`. Do NOT remap `wait_agent`/`close_agent`. |
| **pi** | low | flat JSONL with a first-line `{type:'session'}` header; `PI_TOOL_MAP` (e.g. `read→Read`); otherwise claude-like flat tool entries. |
| **gemini** | low | per `normalizers.py` gemini fn — flat tool entries; note its tool-name shape. |
| **opencode** | moderate | `_normalize_opencode_args`: infer `file_path` from `filePath` / `path` / `file` / extracted from `apply_patch` patch text. Preserve that inference exactly. |
| **copilot** | moderate | `_normalize_copilot_args`: infer `file_path` and `skill_name` from multiple possible fields; events come from `session-state/<id>/events.jsonl`. |
| **kimi** | moderate (normalizer) | normalizer is claude-ish, but also sum `tool.result` UTF-8 bytes (`_kimi_tool_result_total_bytes`, used by economics `tool_result_total_bytes`). |
| **antigravity** | hard | **dual-location** tool calls: top-level AND nested under `PLANNER_RESPONSE`; deep-descent both and de-dup per the Python. |

**Wave-A test:** each Bob mines a real `results/*-<agent>-*` (or model-variant) run with a **single session file** (so one file's normalization == the committed `coding-agent-tool-calls.jsonl`), copies session + expected into `test/fixtures/<agent>/`, and asserts `normalize<Agent>Logs(session)` deep-equals the parsed expected rows. If no eligible single-session real run exists, report it (don't fake a parity claim) and fall back to a small synthetic fixture marked as such.

---

## Provisioning specs (Wave B) — read `runner.py` + the agent module

- **codex** (`CodexAgent`): `mkdir CODEX_HOME`; `codex login --with-api-key` (pipe `OPENAI_API_KEY` to stdin, env `CODEX_HOME`); install superpowers plugin hooks (`SUPERPOWERS_ROOT`). required_env `[OPENAI_API_KEY, SUPERPOWERS_ROOT]`. Env via `env.ts`/`envSnapshot()`.
- **gemini**: extension-linking against `SUPERPOWERS_ROOT`, `GEMINI_CLI_HOME` isolation.
- **pi**: `config.json` + `settings.json` generation, configurable provider/model/auth.
- **copilot**: stage Superpowers into `COPILOT_HOME`, `--plugin-dir`, `COPILOT_GAUNTLET_ENV_ALLOWLIST` filtering.
- **opencode** (`OpenCodeAgent`): XDG env isolation; session export via `opencode` CLI subprocess (see `opencode_capture.py`).
- **kimi** (`KimiAgent`): the full `kimi.py` protocol — model env defaults+merge, KIMI home bootstrap (nested dirs, symlink validation), `session_index.jsonl` workdir attribution, SHA256 preflight sentinel, stream-json reply parsing, superpowers plugin manifest validation. **Hardest; dedicate a Bob.**
- **antigravity** (`AntigravityAgent`): `agy` CLI (`--gemini_dir` isolation, tmux); `AgyRateLimitWatcher` (daemon tailing `agy.log` for `429`/`RESOURCE_EXHAUSTED` → teardown + `is_rate_limited` → runner maps to `indeterminate`); OAuth creds backup/restore (`agy_creds`); tmux server discovery + reap (`agy_teardown`). **Second-hardest; dedicate a Bob.**

**Conformance (all):** named exports + `import type`; process.env ONLY via `env.ts`; subprocess env from `{ ...envSnapshot(), … }`; no `any`/`as any`/`as never`/`!`; zod-parse boundaries; `RunnerError(stage)` for setup failures; bracket-access index signatures; `//` comments only (Biome corrupts `*/`-containing block comments).

---

## Definition of done (Spec 2)
All 7 agents: normalizer at replay-parity vs recorded data; provisioning adapter resolves and (where mock-able) drives a parity verdict; `NORMALIZERS` + `resolveAgent` wired; codex/kimi/pi cwd-filtering and antigravity rate-limit→indeterminate in place. `bun run check` green. (Live per-agent smoke is trusted-maintainer; the gate stays hermetic via recorded fixtures + mock-gauntlet.)

---

## Fixture-mining notes (discovered during Wave A; read before re-running)

Wave A blew the account token ceiling — largely because each Bob scanned `results/` and read large session logs to mine a replay fixture, and fixture location is **agent-specific**. **Pre-mine fixtures cheaply (filesystem cp + a one-shot Python `normalize_<agent>_logs` diff, no large reads into context), commit them, then have Bobs build only the normalizer + a test against the pre-placed fixture.** Per-agent status (real runs exist for all):

- **codex** — DONE (integrated, real-data replay green).
- **gemini** — clean single-session fixture available (`coding-agent-config/.gemini/tmp/.../chats/session-*.jsonl`, ~3 rows).
- **pi** — clean single-session fixture (`coding-agent-config/sessions/*.jsonl`).
- **copilot** — clean single-session fixture (`coding-agent-config/session-state/<id>/events.jsonl`).
- **kimi** — `session_index.jsonl` is the workdir-attribution INDEX, not the tool-call log; the real log lives elsewhere in the kimi home. Needs kimi-aware mining (read `kimi.py` / the yaml glob).
- **opencode** — tool-calls come from a CLI **export** (`opencode_capture.py` subprocess), not an on-disk `.jsonl` under `coding-agent-config`. Replay fixture must capture the exported form.
- **antigravity** — multi-file + dual-location (`PLANNER_RESPONSE`); the committed tool-calls concatenate across files, so a single-file oracle needs the right file or a concat.

**Rate-limit lesson:** cap concurrent worktree Bobs and pre-supply fixtures; a 7-wide wave of results/-scanning Bobs cost ~770k tokens and hit the ceiling.

---

## Wave A — DONE (commits 1bd11ed fixtures, 083bdc1 normalizers)

All 8 dialect normalizers at Python-oracle replay parity; `NORMALIZERS` wired.
`bun run check` green (105 pass). The rate-limit fix worked: fixtures pre-mined
from the **Python oracle over the curated `tests/quorum/test_normalizers.py`
inputs** (NOT real `results/` logs — better coverage, zero scan, safe to commit),
6 Bobs each built one normalizer + a 3-line replay test against the pre-placed
`test/fixtures/<agent>/cases.json`. Cost ~588k tokens, no ceiling hit.

**Methodology that worked:** the parity oracle is "TS output == Python output
over the same input." `tools/gen_ts_replay_fixtures.py` (transitional dev tool,
delete at cutover) runs the real `normalize_<agent>_logs` over authored inputs
and freezes `cases.json`; the shared harness `test/replay-cases.ts` asserts it.
`gen --check` is a parity-drift detector. Adding a fixture case CANNOT make a
false parity claim — it only chooses which shapes are covered. Each verifier-found
fix got a new oracle-backed case before being applied.

**Verifier-found parity fixes** (adversarial verify stage caught all; high value):
- gemini: dedup keys on raw id **truthiness** (`id: unknown`); a non-string id
  no longer drops the call.
- pi: `subagent`→`Agent` alias decided on the **raw** arguments object-ness
  (absent→`{}`→Agent; non-object/null→`subagent`), pre-coercion.
- kimi: absent `args` key → `{}` (not `{raw_args: undefined}`).
- opencode/copilot: skill selection uses Python **falsy-fallthrough (`or`)**, not
  nullish (`??`) — empty/non-string skill no longer mis-captures the name.
- opencode: present-null `state.input` preserved as `raw_input: null`.
- antigravity: present-null `args` → `{raw_args: null}` (absence-only default).

**Accepted divergences** (documented in-source; NOT fixtured — reproducing them
needs breaking the `ToolCall` contract or matching a Python crash):
- non-object `args` → coerced to `{}`; non-string `name` → `''` (contract types
  `args: Record`, `tool: string`; real logs never emit these).
- gemini/pi: Python *crashes* (TypeError/AttributeError) on non-iterable
  `messages`/`toolCalls`/`content`; TS is robust and skips. Can't be "parity"
  with an exception.
- antigravity `canonicalValue`: JS `JSON.parse` rejects `NaN`/`Infinity` and
  parses bignum literals lossily (Python `json.loads` differs). Pathological as
  command/path/bool values.
- apply_patch path split uses `\n` (LF + CRLF both work via `.trim()`); Python
  `splitlines()` also splits bare `\r`/`\v`/`\f`/Unicode seps — not matched
  (control-chars in regex hit Biome `noControlCharactersInRegex`; unreachable in
  real `\n`-delimited patch bodies).

**Remaining Spec 2:** Wave B provisioning adapters (`src/agents/`, shared
`resolveAgent`) + Wave C (cwd-filtering in capture for codex/kimi/pi; antigravity
rate-limit→`indeterminate` in the runner). kimi/antigravity provisioning are the
heavy lifts — dedicate Bobs, ground from `kimi.py`/`agy_*.py`/`opencode_capture.py`.

---

## Wave B — execution notes (from Kepler's recon, 2026-06-12)

**TS contract today:** `interface CodingAgent { readonly config: AgentConfig;
provision(home: RunHome): Record<string,string>; }` where `RunHome = {configDir,
workdir, skeletonRoot?}`. The runner: `loadAgentConfig` → enforce `required_env`
→ `resolveAgent(config)` (claude family → `ClaudeAgent`, else `DefaultAgent`) →
`agent.provision(home)` returns extra env → `spawnSync('gauntlet', argv, {env:
{...envSnapshot(), QUORUM_AGENT_CWD, ...extraEnv}})` → capture. Setup failures
`throw new RunnerError(msg, 'setup')` → indeterminate.

**The testability crux:** subprocess execution is NOT abstracted in the TS code
(Spec 1 only stubs the `gauntlet` binary via `mock-gauntlet` on PATH). Real
provisioning shells out: `codex login --with-api-key` (stdin), `gemini extensions
link/list`, opencode/kimi/agy preflight (`ask`/reply "OK"), `agy plugin install`,
the `AgyRateLimitWatcher` thread. None can run in the hermetic gate.

**DECISION — introduce a `CommandRunner` seam** (`src/agents/command-runner.ts`):
`interface CommandRunner { run(cmd, args, opts?): {status, stdout, stderr} }`,
default impl wraps `spawnSync`; a `FakeCommandRunner` (test helper) records calls
and returns canned results. Adapters receive a runner (constructor-injected,
defaulting to the real one). This makes provisioning unit-testable at the
**file/env/argv level** (assert: dirs created, config/env files + content,
returned env map, and the exact commands+args+stdin invoked). The live subprocess
paths only execute under real `quorum run` (trusted-maintainer). This is the
parity bar for Wave B: hermetic tests prove the *generation* logic; subprocess
*execution* is exercised live.

**Decomposition (mirrors Wave A's pre-scaffold → disjoint fan-out → integrate):**
- **B1 foundation (sequential, 1 step):** `command-runner.ts` (interface + real
  impl + `FakeCommandRunner`); thread a `CommandRunner` through adapter
  construction/`resolveAgent` (DefaultAgent/ClaudeAgent unchanged behaviorally);
  a `provisionInTempHome` test helper. Gate green. Unblocks B2.
- **B2 adapters (fan out, disjoint files `src/agents/<agent>.ts` + tests; do NOT
  touch the shared `resolveAgent` registry — integrator wires it):**
  - declarative: **pi** (~40L: auth.json/settings.json/pi.env, no subprocess).
  - login-ceremony: **codex** (`codex login` stdin + plugin hooks),
    **gemini** (settings.json + `.gemini-env` + `extensions link/list` + manifest
    verify).
  - custom-hard: **copilot** (`COPILOT_GAUNTLET_ENV_ALLOWLIST` filtering +
    `.copilot-env` + dirs + plugin stage + post-run secret-leak scan, no
    subprocess), **opencode** (XDG isolation + `opencode.json` model pin + plugin
    symlink + `node --check` + preflight `ask`), **kimi** (port `kimi.py`: binary
    resolve, `effective_kimi_model_env` merge, SHA256 sentinel preflight, plugin
    install, `build_kimi_subprocess_env`, runtime env file, effective config),
    **antigravity** (port `agy_watch`/`agy_creds`/`agy_teardown`: preflight,
    `agy plugin install`, settings, rate-limit watcher, OAuth backup/restore,
    tmux reap, launch-cwd visible-symlink wrapping).
- **B3 integration / Wave C:** wire `resolveAgent` to all custom adapters;
  antigravity `rate_limited` → short-circuit `indeterminate` in the runner
  (`InvokeGauntletResult` gains the flag); port `filter_{codex,kimi,pi}_logs_by_cwd`
  into the normalizer modules and call them in `captureToolCalls()` with
  `launchCwd` before normalizing (currently MISSING in TS). Mock-gauntlet smokes.

**Required env per agent:** codex `[OPENAI_API_KEY, SUPERPOWERS_ROOT]`; gemini
`[GEMINI_API_KEY, SUPERPOWERS_ROOT]`; pi `[SUPERPOWERS_ROOT, PI_PROVIDER, PI_MODEL,
PI_API_KEY]`; copilot `[SUPERPOWERS_ROOT]` (+optional token/allowlist); opencode
`[SUPERPOWERS_ROOT]`; kimi `[SUPERPOWERS_ROOT, KIMI_MODEL_API_KEY]`; antigravity
`[SUPERPOWERS_ROOT]`.
