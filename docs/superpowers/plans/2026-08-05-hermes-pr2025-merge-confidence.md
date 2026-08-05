# Hermes PR #2025 Merge-Confidence Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the three trust fixes (normalizer pricing, tool map, pin-probe timeout), add the persistence-probe scenario and PR-testing recipe, then run the pre-registered battery against a pinned PR-2025 head on a commit-pinned hermes CLI.

**Architecture:** Tasks 1–6 are code/docs in `superpowers-evals` (TDD, one commit each). Task 7 is the campaign runbook: image retag+rebuild, in-container ground-truth probes, CLI pin, smoke, battery + RED arm, experiment log. Spec: `docs/superpowers/specs/2026-08-05-hermes-pr2025-merge-confidence-design.md` (v2 — read it first).

**Tech Stack:** Bun ≥1.3.14, TypeScript, bun:test, biome (single quotes), Docker (`superpowers-evals:local`), `@primeradianthq/obol` (lockfile 0.8.0).

## Global Constraints

- Work in an isolated worktree off `main` (another session commits to this checkout; use `superpowers:using-git-worktrees` → `.worktrees/hermes-pr2025`).
- Run `bun install` ONCE before any test run — local `node_modules` currently holds a stray obol 0.9.0 symlink; the lockfile pins 0.8.0.
- Cost assertions must be structural (non-null, > 0, `unpriced_models` empty) — NEVER an exact dollar figure (rates differ across obol 0.8.0/0.9.0).
- Match surrounding style; do not touch unrelated whitespace; `bun run check` (biome + tsc + tests) must be green at every commit.
- Live container/battery steps (Task 7) are trusted-maintainer operations; never wire them into CI.
- Tool-name ground truth: Tasks 2's map entries come from the PR's `hermes-tools.md`; Task 7 step 4 verifies them against the real CLI **before** the battery. If the probe contradicts a name, fix map+tests then, before run 1.

---

### Task 1: Normalizer pricing — model id, provider hint, embedded-estimate policy

**Files:**
- Modify: `src/normalize/hermes.ts` (buildSessionFinalMetrics ~149–184, its doc comment ~127–148, trajectory assembly ~414–420)
- Test: `test/normalize.hermes.test.ts`

**Interfaces:**
- Produces: `normalizeHermes` output gains `agent.model_name` (from session `model`), `final_metrics.extra.provider` (from session `billing_provider`), and `final_metrics.total_cost_usd` falls back to `estimated_cost_usd` when `actual_cost_usd` is null. Task 7's smoke relies on these to price runs.

- [ ] **Step 1: `bun install`** (global constraint — fix the obol symlink drift before any test).

- [ ] **Step 2: Update the changed-behavior tests and add new failing tests**

In `test/normalize.hermes.test.ts`:

(a) REPLACE the test `'estimated_cost_usd is never carried; only actual_cost_usd maps to total_cost_usd'` (near line 502) with:

```ts
test('estimated_cost_usd is honored when actual_cost_usd is absent', () => {
  const traj = normalizeHermes(
    sessionWithTopLevelTokens({ actual_cost_usd: null }),
    '1.0.0',
  );
  // Policy (spec v2 decision 4): hermes' own estimate is the same kind of
  // harness-computed estimate quorum already honors from pi/opencode.
  expect(traj.final_metrics?.total_cost_usd).toBe(0.0099);
});

test('actual_cost_usd wins over estimated_cost_usd when both are set', () => {
  const traj = normalizeHermes(sessionWithTopLevelTokens(), '1.0.0');
  expect(traj.final_metrics?.total_cost_usd).toBe(0.0042);
});
```

(b) ADD after the `sessionWithTopLevelTokens` tests:

```ts
test('billing_provider folds into final_metrics.extra.provider', () => {
  const traj = normalizeHermes(
    sessionWithTopLevelTokens({ billing_provider: 'openrouter' }),
    '1.0.0',
  );
  expect(traj.final_metrics?.extra?.['provider']).toBe('openrouter');
});

test('agent.model_name is stamped from the session-level model id', () => {
  const traj = normalizeHermes(
    sessionWithTopLevelTokens({ model: 'z-ai/glm-5.2' }),
    '1.0.0',
  );
  expect(traj.agent.model_name).toBe('z-ai/glm-5.2');
});

test('agent.model_name is absent when the session carries no model field', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  expect(traj.agent.model_name).toBeUndefined();
});
```

(c) REPLACE the real-fixture fold test `'real captured session: session-level totals fold into final_metrics'` expectation with (fixture facts: `estimated_cost_usd: 0.012235862`, `actual_cost_usd: null`, `billing_provider: 'openrouter'`, `model: 'z-ai/glm-5.2'`):

```ts
test('real captured session: session-level totals fold into final_metrics', () => {
  const traj = normalizeHermes(realSession, '1.0.0');
  expect(traj.final_metrics).toEqual({
    total_prompt_tokens: 11780,
    total_completion_tokens: 51, // 33 + 18 reasoning, folded
    total_cost_usd: 0.012235862, // estimated_cost_usd (actual is null)
    extra: {
      total_cached_tokens: 17856,
      cache_write: 0,
      provider: 'openrouter',
    },
  });
});

test('real captured session: agent.model_name is the session model id', () => {
  const traj = normalizeHermes(realSession, '1.0.0');
  expect(traj.agent.model_name).toBe('z-ai/glm-5.2');
});
```

(d) ADD an end-to-end obol pricing test at the bottom of the file (imports to merge at top: `mkdtempSync, writeFileSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`, `estimateTrajectory` from `../src/obol/index.ts`):

```ts
test('real captured session prices end-to-end via obol (no UnknownModelForTurn)', async () => {
  const traj = normalizeHermes(realSession, '1.0.0');
  const dir = mkdtempSync(join(tmpdir(), 'hermes-price-'));
  const path = join(dir, 'trajectory.json');
  writeFileSync(path, JSON.stringify(traj));
  const usage = await estimateTrajectory(path);
  expect(usage).not.toBeNull();
  // Structural only — never an exact dollar figure (obol 0.8.0 vs 0.9.0 differ).
  expect(usage!.est_cost_usd).not.toBeNull();
  expect(usage!.est_cost_usd!).toBeGreaterThan(0);
  expect(usage!.unpriced_models).toEqual([]);
});
```

(e) Update the mirrored field-mapping comment block (near lines 443–467): `actual_cost_usd else estimated_cost_usd -> total_cost_usd`; `cache_write` marked "bookkeeping only — obol's atif dialect does not read this key (probe-verified 2026-08-05)"; add `billing_provider -> extra.provider (the provider hint obol needs to resolve provider-gated rates like z-ai/glm-5.2)` and `model -> agent.model_name`.

- [ ] **Step 3: Run to verify the new tests fail**

Run: `bun test test/normalize.hermes.test.ts`
Expected: FAIL — `total_cost_usd` undefined for the estimated-fallback tests, `extra.provider` / `model_name` undefined, e2e test `est_cost_usd` null.

- [ ] **Step 4: Implement in `src/normalize/hermes.ts`**

(a) In `buildSessionFinalMetrics`, after `const actualCostUsd = …` add and use:

```ts
  const estimatedCostUsd = numOrUndefined(session['estimated_cost_usd']);
```

replace the `if (actualCostUsd !== undefined) { finalMetrics.total_cost_usd = actualCostUsd; }` block with:

```ts
  const costUsd = actualCostUsd ?? estimatedCostUsd;
  if (costUsd !== undefined) {
    finalMetrics.total_cost_usd = costUsd;
  }
```

and inside the `extra` assembly, after the `cache_write` line, add:

```ts
  const billingProvider = session['billing_provider'];
  if (typeof billingProvider === 'string' && billingProvider !== '') {
    extra['provider'] = billingProvider;
  }
```

(b) In `normalizeHermes`, after the `const traj: AtifTrajectory = { … }` assembly and before `validateTrajectory`, add:

```ts
  const sessionModel = sessionTokenFields?.['model'];
  if (typeof sessionModel === 'string' && sessionModel !== '') {
    traj.agent.model_name = sessionModel;
  }
```

(c) Rewrite the `buildSessionFinalMetrics` doc comment's mapping lines to match (a): `actual_cost_usd, else estimated_cost_usd -> total_cost_usd` (estimate honored per the pi/opencode embedded-estimate precedent); `cache_write_tokens -> extra.cache_write (bookkeeping only — obol's atif dialect does not read this key)`; add `billing_provider -> extra.provider` and note the model stamping (copilot precedent, `src/normalize/copilot.ts:335`).

- [ ] **Step 5: Run tests, verify pass**

Run: `bun test test/normalize.hermes.test.ts`
Expected: PASS (all, including the e2e obol test).

- [ ] **Step 6: `bun run check`, then commit**

```bash
git add src/normalize/hermes.ts test/normalize.hermes.test.ts
git commit -m "hermes normalizer: stamp model_name + provider, honor estimated_cost_usd — prices GLM 5.2 runs"
```

---

### Task 2: Tool map — delegate_task, patch, web_extract, todo

**Files:**
- Modify: `src/normalize/hermes.ts` (`HERMES_TOOL_MAP` ~23–63, `normalizeHermesArgs` ~91–99)
- Test: `test/normalize.hermes.test.ts`

**Interfaces:**
- Produces: `delegate_task` → `Agent` with `arguments.prompt` (renamed from `goal`); `patch` → `Edit`; `web_extract` → `WebFetch`; `todo` → `TodoWrite`. Transcript verbs (`tool-called Agent`, `skill-before-tool … Edit`) depend on these.

- [ ] **Step 1: Write failing tests** (append to `test/normalize.hermes.test.ts`; reuse the message-wrapping shape of the existing `'tool map: str_replace_based_edit_tool → Edit'` test):

```ts
function sessionWithOneToolCall(name: string, args: Record<string, unknown>) {
  return JSON.stringify({
    messages: [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc-1', function: { name, arguments: JSON.stringify(args) } },
        ],
      },
      { role: 'tool', tool_call_id: 'tc-1', content: 'ok' },
    ],
  });
}

test('tool map: delegate_task → Agent with goal renamed to prompt', () => {
  const traj = normalizeHermes(
    sessionWithOneToolCall('delegate_task', {
      goal: 'write the tests',
      context: 'repo uses bun',
      role: 'leaf',
    }),
    '1.0.0',
  );
  const toolStep = traj.steps.find((s) => s.tool_calls !== undefined);
  expect(toolStep!.tool_calls![0]!.function_name).toBe('Agent');
  expect(toolStep!.tool_calls![0]!.arguments['prompt']).toBe('write the tests');
  expect(toolStep!.tool_calls![0]!.arguments['goal']).toBeUndefined();
  expect(toolStep!.tool_calls![0]!.arguments['context']).toBe('repo uses bun');
});

test('tool map: patch → Edit', () => {
  const traj = normalizeHermes(
    sessionWithOneToolCall('patch', { path: 'a.ts' }),
    '1.0.0',
  );
  const toolStep = traj.steps.find((s) => s.tool_calls !== undefined);
  expect(toolStep!.tool_calls![0]!.function_name).toBe('Edit');
});

test('tool map: web_extract → WebFetch', () => {
  const traj = normalizeHermes(
    sessionWithOneToolCall('web_extract', { url: 'https://example.com' }),
    '1.0.0',
  );
  const toolStep = traj.steps.find((s) => s.tool_calls !== undefined);
  expect(toolStep!.tool_calls![0]!.function_name).toBe('WebFetch');
});

test('tool map: todo → TodoWrite', () => {
  const traj = normalizeHermes(
    sessionWithOneToolCall('todo', { items: [] }),
    '1.0.0',
  );
  const toolStep = traj.steps.find((s) => s.tool_calls !== undefined);
  expect(toolStep!.tool_calls![0]!.function_name).toBe('TodoWrite');
});
```

- [ ] **Step 2: Run to verify fail** — `bun test test/normalize.hermes.test.ts` → the four new tests FAIL (names pass through unmapped; `prompt` undefined).

- [ ] **Step 3: Implement**

(a) In `HERMES_TOOL_MAP`: add `delegate_task: 'Agent',` under the subagent-dispatch group; add `patch: 'Edit',` under file editing; add `web_extract: 'WebFetch',` under web; add a task-tracking group `todo: 'TodoWrite',`. Source note in the comment: names from PR #2025's `hermes-tools.md`, live-verify at the Task 7 toolset probe.

(b) In `normalizeHermesArgs`, add a `delegate_task` branch (hermes carries the instruction under `goal`; the house canonical key is `prompt` — `canonicalizeAgentPrompt` only renames `task`, so do it here like the `skill_view` special case):

```ts
function normalizeHermesArgs(
  nativeName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (nativeName === 'skill_view') {
    const name = args['name'];
    if (typeof name !== 'string') return args;
    return { ...args, skill: name };
  }
  if (nativeName === 'delegate_task') {
    const goal = args['goal'];
    if (typeof goal !== 'string' || 'prompt' in args) return args;
    const { goal: _goal, ...rest } = args;
    return { ...rest, prompt: goal };
  }
  return args;
}
```

(and update its doc comment: it now handles both special cases).

- [ ] **Step 4: Run tests, verify pass** — `bun test test/normalize.hermes.test.ts` → PASS.

- [ ] **Step 5: `bun run check`, commit**

```bash
git add src/normalize/hermes.ts test/normalize.hermes.test.ts
git commit -m "hermes normalizer: map delegate_task/patch/web_extract/todo to canonical tools"
```

---

### Task 3: Pin-probe timeout + agents-resolve hermes case

**Files:**
- Modify: `src/contracts/agent-config.ts` (`probeCliVersionLine` ~77–84 — add export + timeout param)
- Modify: `test/agent-config.test.ts`, `test/agents-resolve.test.ts`

**Interfaces:**
- Produces: `export function probeCliVersionLine(binary: string, timeoutMs = 30_000): string | null` — timeout maps to the existing null path (→ `CodingAgentConfigError` in `enforceCliVersionPin`, unchanged).

- [ ] **Step 1: Write failing tests**

In `test/agent-config.test.ts` (merge imports: `probeCliVersionLine` from `../src/contracts/agent-config.ts`; `mkdtempSync, writeFileSync` from `node:fs`; `tmpdir` from `node:os`; `join` from `node:path`):

```ts
test('probeCliVersionLine returns the first stdout line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-probe-'));
  const bin = join(dir, 'fake-agent');
  writeFileSync(bin, '#!/bin/sh\necho "Fake Agent v1.2.3 (2026.1.1)"\n', {
    mode: 0o755,
  });
  expect(probeCliVersionLine(bin)).toBe('Fake Agent v1.2.3 (2026.1.1)');
});

test('probeCliVersionLine times out (null) on a wedged binary', () => {
  // hermes --version performs a synchronous network update check; in an
  // egress-restricted container it can hang forever without a timeout.
  const dir = mkdtempSync(join(tmpdir(), 'pin-probe-'));
  const bin = join(dir, 'wedged-agent');
  writeFileSync(bin, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  expect(probeCliVersionLine(bin, 200)).toBeNull();
});
```

In `test/agents-resolve.test.ts`: add `import { HermesAgent } from '../src/agents/hermes.ts';` and, inside `'resolveAgent dispatches each dialect name to its custom adapter'`, add:

```ts
  expect(resolveAgent(cfg('hermes'))).toBeInstanceOf(HermesAgent);
```

- [ ] **Step 2: Run to verify fail** — `bun test test/agent-config.test.ts test/agents-resolve.test.ts`. Expected: agent-config FAILS to compile (probeCliVersionLine not exported) or the timeout test hangs-then-fails; the resolve test PASSES already (dispatch exists at `src/agents/index.ts` — the case was merely missing coverage; that is fine, note it and keep the test).

- [ ] **Step 3: Implement** — in `src/contracts/agent-config.ts` change the function signature/options:

```ts
export function probeCliVersionLine(
  binary: string,
  timeoutMs = 30_000,
): string | null {
  const p = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
```

(rest of the body unchanged — `p.error` covers ETIMEDOUT; update the preceding comment to mention the timeout and why).

- [ ] **Step 4: Run tests, verify pass** — both files PASS; timeout test completes in ~0.2s.

- [ ] **Step 5: `bun run check`, commit**

```bash
git add src/contracts/agent-config.ts test/agent-config.test.ts test/agents-resolve.test.ts
git commit -m "pin probe: 30s spawn timeout + export for tests; cover hermes adapter dispatch"
```

---

### Task 4: Persistence-probe scenario

**Files:**
- Create: `scenarios/superpowers-bootstrap-persistence/story.md`
- Create: `scenarios/superpowers-bootstrap-persistence/setup.sh` (executable)
- Create: `scenarios/superpowers-bootstrap-persistence/checks.sh` (NOT executable)

**Interfaces:**
- Consumes: prelude verbs `git-repo`, `git-branch`, `bootstrap-installed`, `check-transcript skill-called/skill-before-tool` (all existing).
- Produces: the battery's only cell that behaviorally observes hermes' first-turn `api_content` replay.

- [ ] **Step 1: Create the three files**

`story.md`:

```markdown
---
id: superpowers-bootstrap-persistence
title: Bootstrap survives to a later turn — naive trigger on turn two
status: ready
quorum_tier: sentinel
tags: bootstrap
---

You are a developer starting a new project with this coding agent.

Turn 1 — when the agent is at its input prompt, type this exact message and
press Enter:

"What files are in this repo? Give me a one-line summary."

Wait for the agent to finish answering completely and return to its input
prompt.

Turn 2 — then type this exact message and press Enter:

"Let's make a react todo list"

Do NOT mention Superpowers, plugins, skills, brainstorming, planning, or
tests in either turn. The point is to see whether startup context injected on
the FIRST turn still governs behavior on a LATER turn.

Once the agent has loaded a skill, started brainstorming, or started writing
tests or code in response to turn 2, you are done. Do not drive the todo app
to completion.

## Acceptance Criteria

- The Superpowers plugin was staged into the agent's isolated config for this
  run. (Precondition, not the behavioral proof.)
- Turn 1 was answered plainly (a repo summary) — an agent that starts
  brainstorming on turn 1 has not followed the script; note it, but the
  graded turn is turn 2.
- On turn 2 the agent loaded `superpowers:brainstorming` before writing any
  implementation code. The behavioral proof is the normalized transcript: a
  brainstorming skill load (a native `Skill` call or a normalized `Read` of
  the brainstorming `SKILL.md`) appearing before any `Write`/`Edit`.
```

`setup.sh` (mode 0755):

```bash
#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo
```

`checks.sh` (mode 0644):

```bash
# coding-agents: hermes
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

- [ ] **Step 2: Validate** — `bun run quorum check` → new scenario listed clean, no errors. Then `bun run quorum grid-manifest --out /tmp/grid-check.json` and confirm `superpowers-bootstrap-persistence` cells exist for `hermes` only.

- [ ] **Step 3: Commit**

```bash
git add scenarios/superpowers-bootstrap-persistence/
git commit -m "scenario: superpowers-bootstrap-persistence — naive trigger on turn 2 (hermes api_content replay probe)"
```

---

### Task 5: PR-testing recipe in care-and-feeding

**Files:**
- Modify: `docs/coding-agent-care-and-feeding.md` (hermes section, after its existing quirks)

- [ ] **Step 1: Append this subsection to the hermes section** (adjust heading level to match neighbors):

```markdown
#### Testing a superpowers PR against hermes

Hermes provisioning stages `.hermes-plugin/` + `skills/` from
`SUPERPOWERS_ROOT` and fails closed if `.hermes-plugin/` is absent — so a
checkout of the wrong branch cannot silently produce a verdict, and testing a
superpowers PR means pointing the harness at a checkout of that PR. The order
below is mandatory: `QUORUM_SUPERPOWERS_REV` is frozen into the container at
create time and overrides the in-container probe, so a checkout switched
after `up` stamps the WRONG rev into every verdict.

1. Dedicated clone (never a linked worktree — its in-container git probe
   fails; never a checkout other sessions share), detached at the recorded
   PR-head SHA:

       git clone git@github.com:obra/superpowers.git ../superpowers-pr<N>
       cd ../superpowers-pr<N>
       git fetch origin pull/<N>/head && git checkout --detach FETCH_HEAD
       git rev-parse HEAD   # record this SHA; it names the subject everywhere

2. Recreate the container against it (a running container keeps its old
   image AND its old env):

       scripts/evals-container down
       scripts/evals-container --superpowers-root ../superpowers-pr<N> up

3. Run, then verify provenance before trusting anything:

       scripts/evals-container exec quorum run scenarios/superpowers-bootstrap --coding-agent hermes
       # verdict.json .provenance.superpowers_rev must equal the recorded SHA

Identify the subject only as `pull/<N>/head @ <sha>` in docs and comments —
plugin manifest version strings inside PRs go stale and misdate evidence.
```

- [ ] **Step 2: Commit**

```bash
git add docs/coding-agent-care-and-feeding.md
git commit -m "docs: hermes recipe for testing a superpowers PR (pinned clone + container ordering)"
```

---

### Task 6: Dockerfile `HERMES_COMMIT` pin

**Files:**
- Modify: `container/Dockerfile` (hermes block, lines ~148–151)
- Test: `test/container-dockerfile.test.ts`

**Interfaces:**
- Produces: `ARG HERMES_COMMIT=<sha>` — editing the default busts exactly the hermes layer (BuildKit re-runs on RUN-text change); everything above stays cached.

- [ ] **Step 1: Resolve the commit to pin**

```bash
git ls-remote https://github.com/NousResearch/hermes-agent refs/heads/main | cut -f1
```

Record the SHA (call it `$HERMES_SHA`; upstream main — the installer's own default, but frozen).

- [ ] **Step 2: Write the failing test** — in `test/container-dockerfile.test.ts`, next to the existing hermes install-intent assertions, add:

```ts
test('hermes install is commit-pinned via HERMES_COMMIT', () => {
  expect(dockerfile).toContain('ARG HERMES_COMMIT=');
  expect(dockerfile).toContain('--commit "$HERMES_COMMIT"');
});
```

(match the file's existing pattern for reading the Dockerfile into `dockerfile` — reuse the same variable the neighboring tests use).

- [ ] **Step 3: Run to verify fail** — `bun test test/container-dockerfile.test.ts` → new test FAILS.

- [ ] **Step 4: Implement** — replace the hermes RUN block in `container/Dockerfile`:

```dockerfile
# Run as root, the hermes installer uses the FHS layout: code at
# /usr/local/lib/hermes-agent, command at /usr/local/bin/hermes (already on PATH).
# HERMES_COMMIT pins the installed revision: the installer defaults to main
# HEAD, which BuildKit's layer cache would otherwise freeze invisibly — a bare
# rebuild is a cache no-op. Bump the default to move hermes.
ARG HERMES_COMMIT=<paste $HERMES_SHA here>
RUN curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup --commit "$HERMES_COMMIT" \
  && hermes version
```

- [ ] **Step 5: Run tests** — `bun test test/container-dockerfile.test.ts` → PASS. Then `bun run check`.

- [ ] **Step 6: Commit**

```bash
git add container/Dockerfile test/container-dockerfile.test.ts
git commit -m "container: pin hermes install to HERMES_COMMIT (bare rebuilds were cache no-ops)"
```

---

### Task 7: Campaign runbook (trusted-maintainer, live)

**Files:**
- Create: `docs/experiments/2026-08-05-hermes-pr2025-merge-confidence.md` (before run 1 — the decision rules must be pre-registered)
- Modify: `coding-agents/hermes.yaml` (add `pin_cli_version`), `test/agent-config.test.ts` (assert it)

No code beyond the pin; every step records into the experiment doc.

- [ ] **Step 1: Preflight.** Confirm `OPENROUTER_API_KEY` + `ANTHROPIC_API_KEY` present in the container credentials env (`.env.container`); confirm OpenRouter credit balance in its dashboard (a dead Anthropic key masquerades as coding-agent capture failure — check gauntlet `run.jsonl` first if the smoke goes capture-indeterminate).

- [ ] **Step 2: Retag the fallback, rebuild.**

```bash
docker tag superpowers-evals:local superpowers-evals:pre-hermes20-v0190
scripts/evals-container build
docker images --digests | grep superpowers-evals   # record both image IDs
```

- [ ] **Step 3: Pinned PR clone + container recreate** — follow the Task 5 recipe verbatim with `<N>=2025` (expected SHA `b661305…`; record the full 40-char value).

- [ ] **Step 4: In-container ground-truth probes** (record all outputs in the experiment doc):

```bash
scripts/evals-container exec hermes version        # full multi-line output, incl. "upstream <hash>"
scripts/evals-container exec hermes --version      # first line must match `hermes version`'s
scripts/evals-container exec evals-tool-versions   # snapshot — not captured anywhere else for local runs
scripts/evals-container exec hermes plugins install --help   # does it accept a branch/ref? settles the real-install deferral
git -C "$GAUNTLET_ROOT" rev-parse HEAD             # gauntlet stamps no provenance of its own
```

Toolset probe (settles Task 2's map against the real CLI, and whether subagent dispatch mints child sessions): inside the container with a scratch `HOME`, run one `--yolo` session that (i) dispatches a subagent to create `hello.txt` and (ii) edits the file; then `hermes sessions list` + `hermes sessions export --format jsonl --session-id <id> -` and inspect: the native tool names used (expect `delegate_task`, `patch` — if different, fix `HERMES_TOOL_MAP` + tests NOW, before the battery) and whether more than one session appeared (if yes: multi-session runs under-count costs — sum `final_metrics` across exported files becomes a required fix before the battery; if no: record and move on).

- [ ] **Step 5: Commit the pin.** Set `pin_cli_version: "v0.20.<x>"` (the exact version Step 4 reported) in `coding-agents/hermes.yaml` with a comment naming the probe date; add to the hermes case in `test/agent-config.test.ts`:

```ts
  expect(config.pin_cli_version).toBe('v0.20.<x>');
```

`bun run check`, then:

```bash
git add coding-agents/hermes.yaml test/agent-config.test.ts
git commit -m "hermes: pin_cli_version v0.20.<x> (container probe 2026-08-05)"
```

- [ ] **Step 6: Pre-register the experiment doc** — create `docs/experiments/2026-08-05-hermes-pr2025-merge-confidence.md` with: subject `pull/2025/head @ <sha>`; the provenance block (Step 2–4 outputs); and these decision rules copied verbatim BEFORE run 1, then commit it:

```markdown
## Decision rules (pre-registered before run 1)

- superpowers-bootstrap: pass = ≥2/3. The v0.20 smoke counts as run 1 iff its
  capture is intact, regardless of verdict.
- RED arm (neutered pre_llm_call) must FAIL; if it passes, all greens are
  void (native skill registration is carrying the scenario).
- triggering-*: n=1 screen. Any fail → that cell escalates to n=3 AND gets a
  same-hour paired pi run (same scenario, same credential):
  hermes-fail + pi-pass ⇒ delivery mechanism; hermes-fail + pi-fail ⇒ model.
- Every fail: check ~/.hermes/logs/agent.log for compaction before it counts
  as PR evidence.
- Every skill-called pass: record whether Skill (skill_view) or the Read
  fallback matched. Majority-fallback greens falsify native registration.
- Reporting: existence proofs only, no reliability rates from n≤3; compaction
  untested by design; GLM-5.2-only; OpenRouter provider routing uncontrolled.
```

- [ ] **Step 7: Smoke** (= bootstrap run 1): `scripts/evals-container exec quorum run scenarios/superpowers-bootstrap --coding-agent hermes`. Gate before continuing: `verdict.json .provenance.superpowers_rev` equals the recorded SHA; capture intact (trajectory.json exists, nonzero steps); economics priced (`bun run quorum costs <run>` shows a nonzero coding cost — Task 1 live-verified). Harness breakage here → the spec's fallback: retag `pre-hermes20-v0190` back to `:local`, `down && up`, re-pin `v0.19.0`, file the v0.20 drift separately.

- [ ] **Step 8: RED arm.** Copy the pinned clone, neuter the hook, run bootstrap once against it, restore the container to the real clone afterward:

```bash
cp -R ../superpowers-pr2025 ../superpowers-pr2025-red
# In ../superpowers-pr2025-red/.hermes-plugin/__init__.py, replace the
# `return {"context": ...}` in the pre_llm_call hook with `return None`
# (grep 'return {"context"' to find it; one line). Verify:
grep -n 'return None' ../superpowers-pr2025-red/.hermes-plugin/__init__.py
scripts/evals-container down && scripts/evals-container --superpowers-root ../superpowers-pr2025-red up
scripts/evals-container exec quorum run scenarios/superpowers-bootstrap --coding-agent hermes
scripts/evals-container down && scripts/evals-container --superpowers-root ../superpowers-pr2025 up
```

Expected: FAIL (bootstrap never delivered). Record per the decision rules.

- [ ] **Step 9: Battery.** Sequential `scripts/evals-container exec quorum run scenarios/<s> --coding-agent hermes`, in this order (bootstrap replicates spread first/middle/last; smoke was run 1):

1. `triggering-writing-plans`
2. `triggering-test-driven-development`
3. `triggering-systematic-debugging`
4. `superpowers-bootstrap` (run 2)
5. `superpowers-bootstrap-persistence`
6. `triggering-requesting-code-review`
7. `triggering-finishing-a-development-branch`
8. `triggering-executing-plans`
9. `triggering-dispatching-parallel-agents`
10. `mid-conversation-skill-invocation` — ONLY if Step 4's probe confirmed a real subagent tool; otherwise record the drop and why
11. `superpowers-bootstrap` (run 3)

Escalations per the pre-registered rules (pi pairs run same-hour, interleaved next to the failing cell).

- [ ] **Step 10: Triage + write-up.** `bun run quorum show <batch/run>` per cell; attribute per `docs/superpowers/skills/triaging-a-failing-eval.md`; fill the experiment doc's matrix (verdict, cost, skill_view-vs-fallback per pass, negatives at equal billing); commit. Post-campaign: rotate `OPENROUTER_API_KEY` (each run home holds it in plaintext under `results/`). Nothing is posted to the PR without Drew's explicit go.

---

## Self-review notes

- Spec coverage: C1→Task 1, C2→Tasks 2+7.4, C3→Tasks 3+7.5, C4→Task 5, C5→Tasks 4+7.6–9, C6→Task 7.10; decision 2 (pin-by-commit, retag fallback)→Tasks 6+7.2/7.7; provenance section→Task 7.2–7.6.
- The mergeTrajectories multi-session fix is deliberately conditional (Step 7.4) per spec C2 — no speculative fix.
- Follow-ups NOT in this plan (spec "Out of scope"): `runtimeCleanupDirs` for hermes `.env`, capture-cascade branch, `AGENT_INSTRUCTION_FILES`, Nous Portal credential, appliance, obol 0.9.0 bump, gauntlet provenance stamping.
