# Serf OpenRouter Attestation Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve OpenRouter generation IDs in private Serf ATIF exports so Quorum can attest labeled campaign routes, and advance the container to an exact fresh Serf source pin.

**Architecture:** Keep Serf's safe default unchanged and opt Quorum's isolated Serf launcher into the existing `raw-local` provider-handle export mode. Keep container provenance reproducible by replacing the immutable `SERF_REF` default with the selected exact Serf commit rather than a branch.

**Tech Stack:** Bash launcher template, Bun/TypeScript contract tests, Dockerfile, Serf ATIF v1.7.

## Global Constraints

- Raw provider response identifiers may exist only in the private per-run ATIF artifact and transient attestation request.
- Do not add prompts, responses, credentials, private hostnames, run identifiers, or private repository information to source control.
- Keep OpenRouter attestation fail-closed when no `gen-...` identifier is available.
- Pin Serf to exact commit `2ae123e1b1301db060efd958bc1c7ff32b14de86`; do not embed a floating branch.
- Do not launch or retry a paid campaign as part of implementation verification.

---

### Task 1: Export raw-local provider handles from the isolated Serf launcher

**Files:**
- Modify: `test/runner-context.test.ts`
- Modify: `coding-agents/serf-context/launch-agent`

**Interfaces:**
- Consumes: Serf CLI flag `--export-atif-provider-handles raw-local` and the existing isolated `--export-atif` path.
- Produces: generated Serf launcher argv containing exactly one fixed provider-handle export mode.

- [ ] **Step 1: Write the failing launcher argv test**

Add this test after the existing shell-significant model argv test in `test/runner-context.test.ts`:

```ts
test('Serf launcher exports raw-local provider handles for OpenRouter attestation', () => {
  const selectedName = 'SERF_TEST_SELECTED_API_KEY';
  const { launcher, binDir, argvDump } = installSerfLauncher(selectedName);

  const proc = spawnSync('bash', [launcher, 'do work'], {
    encoding: 'utf8',
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      [selectedName]: crypto.randomUUID(),
    },
  });

  expect(proc.status).toBe(0);
  const argv = readFileSync(argvDump, 'utf8').trimEnd().split('\n');
  const modeFlag = argv.indexOf('--export-atif-provider-handles');
  expect(modeFlag).toBeGreaterThanOrEqual(0);
  expect(argv[modeFlag + 1]).toBe('raw-local');
  expect(argv.lastIndexOf('--export-atif-provider-handles')).toBe(modeFlag);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
bun test test/runner-context.test.ts --test-name-pattern 'exports raw-local provider handles'
```

Expected: FAIL because `modeFlag` is `-1`.

- [ ] **Step 3: Add the fixed Serf launcher argument**

In `coding-agents/serf-context/launch-agent`, add the argument immediately after the existing `--export-atif` argument:

```bash
    --export-atif "$QUORUM_AGENT_HOME/.serf/exports/trajectory.json" \
    --export-atif-provider-handles raw-local \
```

Update the nearby launcher comment so it states that the private ATIF export retains provider response IDs for route attestation.

- [ ] **Step 4: Run the focused launcher tests to verify GREEN**

Run:

```bash
bun test test/runner-context.test.ts
```

Expected: all tests in `test/runner-context.test.ts` PASS with no warnings.

- [ ] **Step 5: Commit the launcher contract**

```bash
git add test/runner-context.test.ts coding-agents/serf-context/launch-agent
git commit -m "fix(serf): retain OpenRouter generation IDs"
```

### Task 2: Advance the immutable Serf container pin

**Files:**
- Modify: `test/container-dockerfile.test.ts`
- Modify: `container/Dockerfile`

**Interfaces:**
- Consumes: reviewed Serf commit `2ae123e1b1301db060efd958bc1c7ff32b14de86`.
- Produces: container default `ARG SERF_REF=2ae123e1b1301db060efd958bc1c7ff32b14de86`, recorded by the existing `/usr/local/share/serf-source-rev` mechanism.

- [ ] **Step 1: Write the failing exact-pin contract test**

In `test/container-dockerfile.test.ts`, replace the loose Serf-ref assertion with:

```ts
  expect(source).toContain(
    'ARG SERF_REF=2ae123e1b1301db060efd958bc1c7ff32b14de86',
  );
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
bun test test/container-dockerfile.test.ts --test-name-pattern 'installs headless agent CLIs'
```

Expected: FAIL because the Dockerfile still pins `018e30d583f47ee52264476b48de63f4970e04c4`.

- [ ] **Step 3: Update the Dockerfile's exact Serf pin**

Change the Dockerfile argument to:

```dockerfile
ARG SERF_REF=2ae123e1b1301db060efd958bc1c7ff32b14de86
```

Do not change the existing clone, checkout, source-revision, build, or version-check commands.

- [ ] **Step 4: Run the focused container contract tests to verify GREEN**

Run:

```bash
bun test test/container-dockerfile.test.ts
```

Expected: all tests in `test/container-dockerfile.test.ts` PASS.

- [ ] **Step 5: Commit the immutable source pin**

```bash
git add test/container-dockerfile.test.ts container/Dockerfile
git commit -m "build(serf): advance container source pin"
```

### Task 3: Verify the integrated repository state

**Files:**
- Verify only; no additional files.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: a clean, committed repository ready for managed container preflight.

- [ ] **Step 1: Run the two focused contract suites together**

```bash
bun test test/runner-context.test.ts test/container-dockerfile.test.ts
```

Expected: both files PASS.

- [ ] **Step 2: Run repository verification**

```bash
bun run check
bun run quorum check
git diff --check
```

Expected: all commands exit 0; `quorum check` reports every configured scenario and credential valid.

- [ ] **Step 3: Run the public-tree confidentiality check**

```bash
git grep -n -E 'sk-[[:alnum:]-]{20,}|https?://[0-9]{1,3}(\.[0-9]{1,3}){3}' HEAD -- \
  coding-agents/serf-context/launch-agent \
  test/runner-context.test.ts \
  container/Dockerfile \
  test/container-dockerfile.test.ts \
  docs/superpowers/specs/2026-07-11-serf-openrouter-attestation-capture-design.md \
  docs/superpowers/plans/2026-07-11-serf-openrouter-attestation-capture.md
```

Expected: no matches.

- [ ] **Step 4: Confirm the repository is clean**

```bash
git status --short --branch
```

Expected: `main` has no staged, modified, or untracked files. It may be ahead of `origin/main` until the reviewed commits are pushed.
