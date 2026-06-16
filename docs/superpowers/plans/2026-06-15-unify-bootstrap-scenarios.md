# Unify Bootstrap Scenarios Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the seven per-agent `*-superpowers-bootstrap` scenarios with one cross-agent `superpowers-bootstrap` scenario that runs on every agent, preserving the install-time triage signal through a dispatching check verb.

**Architecture:** Expose the coding-agent name to the checks phase as `QUORUM_CODING_AGENT`; add a `bootstrap-installed` verb that reads it and delegates to the existing per-harness install verb (passing for claude/pi, which have none); author one agent-agnostic scenario with no `# coding-agents:` lock; delete the seven old scenario directories.

**Tech Stack:** TypeScript on Bun, biome + tsc, `bun test`, the quorum scenario DSL (bash prelude over the typed check-tool CLI).

**Spec:** `docs/superpowers/specs/2026-06-15-unify-bootstrap-scenarios-design.md`

---

## File Structure

- `src/checks/index.ts` — add `RunPhaseArgs.codingAgent` and export it as `QUORUM_CODING_AGENT` to the checks child env. (Owns the checks-phase subprocess contract.)
- `src/runner/index.ts` — pass `codingAgent: a.codingAgent` at the two `runPhase` call sites (pre ~1037, post ~1396).
- `src/check/fs-verbs.ts` — add `verbBootstrapInstalled` (the dispatcher) next to the existing per-harness verbs.
- `src/check/dispatch.ts` — register `'bootstrap-installed'` in `FS_VERBS`.
- `test/checks.test.ts` — test that `QUORUM_CODING_AGENT` reaches the child env.
- `test/fs-verbs-bootstrap.test.ts` — test the dispatcher's routing table.
- `scenarios/superpowers-bootstrap/{story.md,setup.sh,checks.sh}` — the unified scenario (new).
- `scenarios/{antigravity,codex-native-hooks,copilot,gemini,kimi,opencode,pi}-superpowers-bootstrap/` — deleted.
- `docs/scenario-authoring.md` — document `bootstrap-installed` + `QUORUM_CODING_AGENT`.

---

## Task 1: Expose `QUORUM_CODING_AGENT` to the checks phase

**Files:**
- Modify: `src/checks/index.ts` (`RunPhaseArgs` interface ~20-40; env block ~71-83)
- Modify: `src/runner/index.ts` (`runPhase` calls at ~1037 and ~1396)
- Test: `test/checks.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/checks.test.ts` (it already imports `runPhase`, `checksShWith`, `REPO`, and the node fs/path/os helpers):

```ts
test('QUORUM_CODING_AGENT is exported to the checks child env', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  const checksSh = checksShWith(
    'pre() {\n  command-succeeds \'test "$QUORUM_CODING_AGENT" = gemini\'\n}\npost() { :; }\n',
  );
  const { records, exitCode } = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    repoRoot: REPO,
    codingAgent: 'gemini',
  });
  expect(exitCode).toBe(0);
  expect(records[0]).toMatchObject({ check: 'command-succeeds', passed: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/checks.test.ts`
Expected: a tsc/type error or assertion failure — `codingAgent` is not a known `RunPhaseArgs` field, so either the type check fails or (because the var is unset in the child) the `command-succeeds` record is `passed: false`.

- [ ] **Step 3: Add the field to `RunPhaseArgs`**

In `src/checks/index.ts`, inside the `RunPhaseArgs` interface, after the `configDir` field (~39), add:

```ts
  /**
   * Optional: the coding-agent config name (e.g. `codex`, `claude-sonnet`),
   * exposed to checks as QUORUM_CODING_AGENT so a verb can dispatch per-agent.
   */
  readonly codingAgent?: string;
```

- [ ] **Step 4: Export it to the child env**

In `src/checks/index.ts`, in the `env` object literal (~71-83), add a conditional spread alongside the other optional keys:

```ts
    ...(args.codingAgent !== undefined
      ? { QUORUM_CODING_AGENT: args.codingAgent }
      : {}),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/checks.test.ts`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 6: Thread the agent name from the runner**

In `src/runner/index.ts`, at the `pre` call site (~1037), add `codingAgent: a.codingAgent,` to the `runPhase({…})` object:

```ts
  const pre = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    repoRoot: checksRepoRoot,
    runDir,
    configDir,
    codingAgent: a.codingAgent,
  });
```

And at the `post` call site (~1396), add the same field:

```ts
  const post = await runPhase({
    checksSh,
    phase: 'post',
    workdir,
    repoRoot: checksRepoRoot,
    transcriptPath: capture.path,
    runDir,
    configDir,
    codingAgent: a.codingAgent,
  });
```

- [ ] **Step 7: Typecheck and commit**

Run: `bun run typecheck && bun test test/checks.test.ts`
Expected: no type errors; tests PASS.

```bash
git add src/checks/index.ts src/runner/index.ts test/checks.test.ts
git commit -m "feat: expose QUORUM_CODING_AGENT to the checks phase"
```

---

## Task 2: `bootstrap-installed` dispatcher verb

**Files:**
- Modify: `src/check/fs-verbs.ts` (add `verbBootstrapInstalled` after the per-harness verbs, ~after line 740)
- Modify: `src/check/dispatch.ts` (import + `FS_VERBS` entry)
- Test: `test/fs-verbs-bootstrap.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/fs-verbs-bootstrap.test.ts`. First extend the existing import from `../src/check/fs-verbs.ts` to also import `verbBootstrapInstalled`. Then append:

```ts
// ---------------------------------------------------------------------------
// bootstrap-installed: dispatch on QUORUM_CODING_AGENT
// ---------------------------------------------------------------------------

test('bootstrap-installed routes to the per-harness delegate (gemini)', () => {
  // Unstaged config -> the gemini delegate fails with its own message, which
  // proves routing without needing to stage the gemini file set.
  const cfg = configDir();
  const out = verbBootstrapInstalled(
    [],
    ctxFor(cfg, { QUORUM_CODING_AGENT: 'gemini' }),
  );
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('Gemini');
});

test('bootstrap-installed passes for claude variants (no dedicated check)', () => {
  for (const agent of ['claude', 'claude-haiku', 'claude-sonnet']) {
    const out = verbBootstrapInstalled(
      [],
      ctxFor(configDir(), { QUORUM_CODING_AGENT: agent }),
    );
    expect(out.passed).toBe(true);
    expect(out.detail).toContain('no dedicated install check');
  }
});

test('bootstrap-installed passes for pi (no dedicated check)', () => {
  const out = verbBootstrapInstalled(
    [],
    ctxFor(configDir(), { QUORUM_CODING_AGENT: 'pi' }),
  );
  expect(out.passed).toBe(true);
});

test('bootstrap-installed fails for an unrecognized agent', () => {
  const out = verbBootstrapInstalled(
    [],
    ctxFor(configDir(), { QUORUM_CODING_AGENT: 'bogus' }),
  );
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('unrecognized');
});

test('bootstrap-installed fails when QUORUM_CODING_AGENT is unset', () => {
  const out = verbBootstrapInstalled([], { cwd: '/tmp', env: () => undefined });
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('QUORUM_CODING_AGENT');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/fs-verbs-bootstrap.test.ts`
Expected: FAIL — `verbBootstrapInstalled` is not exported from `fs-verbs.ts`.

- [ ] **Step 3: Implement the dispatcher**

In `src/check/fs-verbs.ts`, after `verbCodexNativeHookConfigured` (the last bootstrap verb, ~line 740), add:

```ts
// bootstrap-installed — dispatch to the per-harness install check for the
// current coding-agent (QUORUM_CODING_AGENT). Claude variants and pi have no
// dedicated install verb; their bootstrap is proven behaviorally, so this
// passes for them. An unknown or unset agent indicates a wiring bug -> fail.
type BootstrapVerb = (args: string[], ctx: CheckContext) => CheckOutcome;

const BOOTSTRAP_DELEGATES: Record<string, BootstrapVerb> = {
  antigravity: verbAntigravityPluginInstalled,
  codex: verbCodexNativeHookConfigured,
  copilot: verbCopilotPluginInstalled,
  gemini: verbGeminiExtensionLinked,
  kimi: verbKimiPluginInstalled,
  opencode: verbOpencodePluginInstalled,
};

const BOOTSTRAP_NO_CHECK = new Set([
  'claude',
  'claude-haiku',
  'claude-sonnet',
  'pi',
]);

export function verbBootstrapInstalled(
  args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const agent = ctx.env('QUORUM_CODING_AGENT');
  if (!agent) {
    return fail('QUORUM_CODING_AGENT is not set');
  }
  const delegate = BOOTSTRAP_DELEGATES[agent];
  if (delegate) {
    return delegate(args, ctx);
  }
  if (BOOTSTRAP_NO_CHECK.has(agent)) {
    return pass(
      `no dedicated install check for ${agent}; behavioral proof covers bootstrap`,
    );
  }
  return fail(`unrecognized coding-agent: ${agent}`);
}
```

- [ ] **Step 4: Register the verb**

In `src/check/dispatch.ts`, add `verbBootstrapInstalled` to the import from `./fs-verbs.ts` (keep the list alphabetized like the existing imports), then add to `FS_VERBS` (~line 53, with the other bootstrap entries):

```ts
  'bootstrap-installed': verbBootstrapInstalled,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/fs-verbs-bootstrap.test.ts`
Expected: PASS (all tests, including the five new ones).

- [ ] **Step 6: Verify the verb is in the prelude vocabulary**

Run: `bun run src/cli/list-check-verbs.ts | grep -x bootstrap-installed`
Expected: prints `bootstrap-installed` (the prelude derives its functions from `Object.keys(FS_VERBS)`, so the bare verb is now callable in checks.sh).

- [ ] **Step 7: Typecheck and commit**

Run: `bun run typecheck`
Expected: no type errors.

```bash
git add src/check/fs-verbs.ts src/check/dispatch.ts test/fs-verbs-bootstrap.test.ts
git commit -m "feat: add bootstrap-installed dispatcher check verb"
```

---

## Task 3: The unified `superpowers-bootstrap` scenario

**Files:**
- Create: `scenarios/superpowers-bootstrap/story.md`
- Create: `scenarios/superpowers-bootstrap/setup.sh`
- Create: `scenarios/superpowers-bootstrap/checks.sh`
- Delete: the seven old `*-superpowers-bootstrap` directories

- [ ] **Step 1: Create `story.md`**

Write `scenarios/superpowers-bootstrap/story.md`:

```markdown
---
id: superpowers-bootstrap
title: Superpowers bootstrap auto-triggers brainstorming on a naive request
status: ready
quorum_tier: sentinel
tags: bootstrap
---

You are a developer starting a new project with this coding agent.

When the agent is at its input prompt, type this exact message and press
Enter:

"Let's make a react todo list"

Do NOT mention Superpowers, plugins, skills, brainstorming, planning, or
tests. The point is to see whether the agent's startup context makes it reach
for the right workflow on its own.

Once the agent has loaded a skill, started brainstorming, or started writing
tests or code, you are done. The goal is to test startup bootstrap, not to
drive the todo app to completion.

## Acceptance Criteria

- The Superpowers plugin was staged into the agent's isolated config for this
  run. (This is a precondition, not the behavioral proof.)
- The agent loaded `superpowers:brainstorming` in response to the naive
  "react todo list" request, before writing any implementation code. The
  behavioral proof is the normalized transcript: a brainstorming skill load
  (a native `Skill` call, OpenCode's `skill` tool, or a normalized `Read` of
  the brainstorming `SKILL.md`) that appears before any `Write`/`Edit`.
```

- [ ] **Step 2: Create `setup.sh`**

Write `scenarios/superpowers-bootstrap/setup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo
```

- [ ] **Step 3: Create `checks.sh`**

Write `scenarios/superpowers-bootstrap/checks.sh` (no `# coding-agents:` directive — it runs on every agent). Do NOT set the executable bit on this file.

```bash
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

- [ ] **Step 4: Verify checks.sh is not executable**

Run: `test ! -x scenarios/superpowers-bootstrap/checks.sh && echo "ok: not executable"`
Expected: prints `ok: not executable`.

- [ ] **Step 5: Delete the seven old scenario directories**

```bash
git rm -r \
  scenarios/antigravity-superpowers-bootstrap \
  scenarios/codex-native-hooks-bootstrap \
  scenarios/copilot-superpowers-bootstrap \
  scenarios/gemini-superpowers-bootstrap \
  scenarios/kimi-superpowers-bootstrap \
  scenarios/opencode-superpowers-bootstrap \
  scenarios/pi-superpowers-bootstrap
```

- [ ] **Step 6: Validate scenarios**

Run: `bun run quorum check`
Expected: PASS — the new scenario validates (valid frontmatter, known verbs including `bootstrap-installed`, no `# coding-agents:` directive), and the seven deletions leave no dangling references.

- [ ] **Step 7: Confirm the new scenario lists and the old ones are gone**

Run: `bun run quorum list | grep -E 'superpowers-bootstrap|-superpowers-bootstrap'`
Expected: exactly one line, `superpowers-bootstrap`. The seven `<agent>-superpowers-bootstrap` entries are absent.

- [ ] **Step 8: Commit**

```bash
git add scenarios/superpowers-bootstrap
git commit -m "feat: unify per-agent bootstrap scenarios into superpowers-bootstrap"
```

(The `git rm` from Step 5 is already staged; this commit includes both the new scenario and the seven deletions.)

---

## Task 4: Document the verb and close out

**Files:**
- Modify: `docs/scenario-authoring.md` (the bootstrap-verbs paragraph, ~394-399)

- [ ] **Step 1: Update the authoring doc**

In `docs/scenario-authoring.md`, replace the "Six **bootstrap verbs**…" paragraph (~394-399) with:

```markdown
Six **bootstrap verbs** take no args and read `QUORUM_AGENT_CONFIG_DIR` to assert
the Superpowers plugin staging in a harness's isolated config:
`antigravity-plugin-installed`, `copilot-plugin-installed`,
`opencode-plugin-installed`, `gemini-extension-linked`, `kimi-plugin-installed`,
`codex-native-hook-configured` (the last two carry extra structured checks; see
`fs-verbs.ts`).

`bootstrap-installed` is the cross-agent dispatcher over those six. It reads
`QUORUM_CODING_AGENT` (the coding-agent config name, exported to the checks
phase by the runner) and delegates to the matching per-harness verb. Claude
variants and pi have no dedicated install verb, so it passes for them — their
bootstrap is proven behaviorally — and an unknown agent fails. Use it in `pre()`
of an agent-agnostic scenario so a missing install reads as indeterminate
(fixture/harness breakage) rather than a behavior failure.
```

- [ ] **Step 2: Final full check**

Run: `bun run check && bun run quorum check`
Expected: biome + tsc + `bun test` all pass; scenario validation passes.

- [ ] **Step 3: Commit**

```bash
git add docs/scenario-authoring.md
git commit -m "docs: document the bootstrap-installed dispatcher verb"
```

---

## Self-Review Notes

- **Spec coverage:** §1 (expose agent identity) → Task 1; §2 (dispatcher verb, full routing table incl. claude/pi/unknown) → Task 2; §3 (unified scenario, sentinel tier, no `# coding-agents:`) → Task 3; §4 (delete seven dirs) → Task 3 Step 5; "Affected files → docs" → Task 4. All spec sections map to a task.
- **Type consistency:** `verbBootstrapInstalled(args, ctx)` matches the `VerbFn` shape `(args: string[], ctx: CheckContext) => CheckOutcome` the `FS_VERBS` table requires. `RunPhaseArgs.codingAgent` is optional, matching the other optional fields, so the existing `runPhase` callers in `test/checks.test.ts` need no change.
- **Tradeoff honored:** the unified `post()` uses only the normalized `skill-called` / `skill-before-tool` verbs (no `tool-arg-match Skill --eq`), exactly as the spec's "drop stricter native-Skill assertions" tradeoff requires.
