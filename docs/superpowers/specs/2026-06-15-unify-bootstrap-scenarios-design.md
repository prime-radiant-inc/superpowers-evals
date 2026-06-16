# Unify the per-agent bootstrap scenarios

## Problem

Seven scenarios — `antigravity-superpowers-bootstrap`,
`codex-native-hooks-bootstrap`, `copilot-superpowers-bootstrap`,
`gemini-superpowers-bootstrap`, `kimi-superpowers-bootstrap`,
`opencode-superpowers-bootstrap`, and `pi-superpowers-bootstrap` — all test the
same canonical behavior the project treats as its integration acceptance test:

> Send "Let's make a react todo list" → `superpowers:brainstorming` must
> auto-load before any implementation code is written.

Each is locked to one agent via `# coding-agents: <agent>` and differs from the
others only in:

1. the `# coding-agents:` lock,
2. one agent-specific install check (`gemini-extension-linked`,
   `codex-native-hook-configured`, `*-plugin-installed`, …) that verifies the
   plugin actually got staged into that harness's isolated config, and
3. incidental transcript-verb variation — most use the agent-agnostic
   `skill-called` + `skill-before-tool`; copilot/opencode *additionally* assert
   the native `Skill` tool; pi was authored against a different, hinted prompt
   entirely.

This is seven copies of one test. It is brittle (every new agent needs a new
near-identical scenario), and it leaves a real gap: there is **no** Claude
bootstrap scenario, so the most common harness has no cross-checked bootstrap
acceptance test at all.

## Goal

Collapse the seven into **one** cross-agent scenario that runs on every agent —
adding Claude coverage — while preserving the install-time triage signal that
distinguishes a harness staging failure from an agent behavior failure.

## Non-goals

- `codex-subagent-wait-mapping` and `codex-tool-mapping-comprehension` stay as
  they are. They test Codex reading and applying the Codex tool-mapping
  reference and assert native codex tool names (`spawn_agent`, `wait_agent`,
  bare `wait`). They are genuinely codex-only and are not bootstrap tests.
- The claude/codex-restricted sdd and worktree scenarios
  (`sdd-spec-context-consumed`, `worktree-creation-under-pressure`,
  `worktree-no-drift-to-main`) are out of scope. They are deliberately
  multi-agent-restricted for real reasons, not "set up one agent and test a
  basic thing."

## Design

### 1. Expose the agent identity to the checks phase

The runner already holds `a.codingAgent`, but the checks phase never receives
it — `runPhase` is given `QUORUM_AGENT_CONFIG_DIR` but not the agent's name, so
a single `checks.sh` cannot branch per-agent today.

Add a `codingAgent` field to `RunPhaseArgs` (`src/checks/index.ts`) and export
it to the child environment as `QUORUM_CODING_AGENT`, alongside the existing
`QUORUM_*` keys. Thread it from both `runPhase` call sites in
`src/runner/index.ts` (the `pre` call ~line 1037 and the `post` call ~line
1396), passing `a.codingAgent` (the precise config name, e.g. `claude-sonnet`,
`codex`, `pi`).

This is isolated plumbing: one new optional field, one conditional spread in the
env block, two call-site additions.

### 2. New dispatcher verb `bootstrap-installed`

Add `verbBootstrapInstalled` to `src/check/fs-verbs.ts` and register it in
`FS_VERBS` (`src/check/dispatch.ts`). It reads `QUORUM_CODING_AGENT` and
delegates to the existing per-harness verb for that harness:

| `QUORUM_CODING_AGENT` | delegates to |
|---|---|
| `antigravity` | `verbAntigravityPluginInstalled` |
| `codex` | `verbCodexNativeHookConfigured` (still asserts the native hook, not the legacy `.agents` symlink) |
| `copilot` | `verbCopilotPluginInstalled` |
| `gemini` | `verbGeminiExtensionLinked` |
| `kimi` | `verbKimiPluginInstalled` |
| `opencode` | `verbOpencodePluginInstalled` |
| `claude`, `claude-haiku`, `claude-sonnet`, `pi` | **pass** with detail `"no dedicated install check for <harness>; behavioral proof covers bootstrap"` |

The dispatch key is the agent config name. The three Claude variants and pi have
no dedicated install verb today, so the dispatcher passes for them with an
explanatory detail — the behavioral assertion in `post()` still proves bootstrap
for those harnesses. An unrecognized `QUORUM_CODING_AGENT` value, or an unset
one, is a `fail` (it indicates a wiring bug, not a clean run).

Because `prelude.sh` derives its bare-verb functions from
`Object.keys(FS_VERBS)` (via `src/cli/list-check-verbs.ts`), the new verb
automatically becomes a callable bare verb and `quorum check` automatically
accepts it. No manual prelude edit; no vocabulary drift.

### 3. New unified scenario `scenarios/superpowers-bootstrap/`

Replaces all seven.

**`story.md`** — agent-agnostic. The canonical naive acceptance test: at the
agent's input prompt, send exactly "Let's make a react todo list"; stop after
the agent's first substantive step; the goal is to observe startup bootstrap,
not to drive the app to completion. Frontmatter `quorum_tier: sentinel` — this
is a core cross-agent acceptance gate. Acceptance criteria:

- The agent loaded `superpowers:brainstorming` in response to the naive request,
  before writing implementation code (the behavioral proof).
- The Superpowers plugin was staged into the agent's isolated config for this
  run (the fixture-sanity precondition).

**`setup.sh`** — `setup-helpers run create_base_repo` (uniform across all seven
today).

**`checks.sh`** — no `# coding-agents:` directive, so it runs on every agent in
the matrix:

```sh
pre() {
    git-repo
    git-branch main
    bootstrap-installed
}

post() {
    check-transcript skill-called superpowers:brainstorming
    check-transcript skill-before-tool superpowers:brainstorming Write
    check-transcript skill-before-tool superpowers:brainstorming Edit
}
```

### 4. Delete the seven old scenario directories

`antigravity-superpowers-bootstrap`, `codex-native-hooks-bootstrap`,
`copilot-superpowers-bootstrap`, `gemini-superpowers-bootstrap`,
`kimi-superpowers-bootstrap`, `opencode-superpowers-bootstrap`,
`pi-superpowers-bootstrap`.

## Deliberate tradeoffs

- **Drop the stricter native-`Skill`-tool assertions** copilot and opencode
  carried (`tool-arg-match Skill --eq skill=superpowers:brainstorming`). The
  normalized `skill-called` verb already abstracts over Read-based skill loads
  (antigravity, kimi, pi) and native-`Skill` loads — it is the only verb that
  works for *every* agent. We keep the behavioral claim ("brainstorming loaded
  before code") and lose only harness-specific precision that does not
  generalize anyway.

- **Cleaner failure attribution.** The install check moves from `post()` to
  `pre()` semantics: a missing install fails the `pre()` phase → the run is
  fixture/harness breakage (indeterminate), while brainstorming-not-triggered
  fails a `post()` assertion → agent behavior failure (fail). This maps onto the
  fail-vs-indeterminate triage tree in `docs/scenario-authoring.md`.

- **pi is held to the naive prompt.** The retired `pi-superpowers-bootstrap`
  used a hinted prompt ("this is a feature-style change, follow your Superpowers
  instructions before editing"). The unified scenario gives pi the same naive
  "Let's make a react todo list" every other agent gets. If pi cannot
  auto-trigger brainstorming without the hint, that is an honest finding, not
  something to paper over — the project's CLAUDE.md treats the naive prompt as
  *the* acceptance test for a real integration.

## Affected files

- `src/checks/index.ts` — `RunPhaseArgs.codingAgent` + `QUORUM_CODING_AGENT`
  env export.
- `src/runner/index.ts` — pass `codingAgent: a.codingAgent` at both `runPhase`
  call sites.
- `src/check/fs-verbs.ts` — `verbBootstrapInstalled`.
- `src/check/dispatch.ts` — register `bootstrap-installed` in `FS_VERBS`.
- `scenarios/superpowers-bootstrap/{story.md,setup.sh,checks.sh}` — new.
- `scenarios/{antigravity,codex-native-hooks,copilot,gemini,kimi,opencode,pi}-superpowers-bootstrap/`
  — deleted.
- `docs/scenario-authoring.md` — document the `bootstrap-installed` verb and
  `QUORUM_CODING_AGENT` if the check-verb vocabulary / env table is enumerated
  there.

## Testing

- Unit test `verbBootstrapInstalled`'s dispatch table: each harness routes to the
  right delegate; claude variants and pi pass with the explanatory detail; an
  unknown/unset `QUORUM_CODING_AGENT` fails. The delegates themselves already
  have coverage — the new test asserts routing, not re-asserts the delegates.
- `bun run check` (biome + tsc + bun test) and `bun run quorum check` (scenario
  validation) both pass — the latter confirms the new verb is in-vocabulary and
  the unified scenario validates with no `# coding-agents:` directive.
