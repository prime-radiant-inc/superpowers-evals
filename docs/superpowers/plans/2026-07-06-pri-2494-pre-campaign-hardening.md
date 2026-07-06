# PRI-2494 Pre-Campaign Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the check-DSL false-pass holes, stamp run provenance into verdict.json, and isolate the claude+codex launchers from host env — the minimal set that makes the obra/superpowers #1931–#1935 eval passes trustworthy.

**Architecture:** Three independent workstreams over existing seams. (1) The check DSL gets crash-band discipline at phase level (ERR trap in `runPhase`'s bash invocation), arity gates in the FS verbs (copying the transcript side's `REQUIRED_ARGS` pattern), a trailing-`**` glob fix, and static verb-name validation in `quorum check`. (2) The runner's single identity-stamping site gains a `provenance` block (git revs + CLI versions), schema-optional so old verdicts parse. (3) The claude launcher template converts to the `env -i` allowlist pattern already proven in opencode/serf; codex hardens the same way.

**Tech Stack:** TypeScript on Bun (≥1.3), bun:test, zod, bash launcher templates. Lint/format via biome; verify with `bun run check`.

## Global Constraints

- TDD for every task: failing test first, then minimal implementation (house rule).
- Commit after every task; never `git add -A` without a fresh `git status`.
- `process.env` reads only via `src/env.ts` (`getEnv`/`envSnapshot`) — Biome enforces (§6.5).
- Honest check failures (exit 1) must CONTINUE a phase; only the crash band (126, 127, ≥128) aborts it. `not` deliberately exits 1, never 127.
- Old verdict.json files (no provenance block) must still parse: all new schema fields optional.
- No behavior change to any existing scenario: every `scenarios/*/checks.sh` must stay valid under the new validation (verified in Task 4).
- Working branch: `drew/pri-2494-quorum-pre-campaign-hardening-close-check-dsl-false-pass`.
- Full check before declaring done: `bun run check` (biome + tsc + bun test) and `bun run quorum check`.

---

### Task 1: Phase-level crash discipline in runPhase (ERR trap)

The hole: `runPhase` (src/checks/index.ts) runs `bash -c "source prelude; source checks.sh; pre"`. A typo'd verb mid-phase exits 127 from that one command, but bash continues, and the phase's exit code is the LAST command's — so the crash vanishes and the composed verdict can be a false pass. Empirically verified: `pre() { file-exsts x; file-exists x; }` → phase rc 0, one record.

The fix, validated by experiment: run the phase body under `set -E` plus an ERR trap that aborts only when `$?` is in the crash band (≥126). Honest fails (rc 1–125) flow on; a 127 anywhere aborts the phase with rc 127, which the existing crash heuristic (`rc === 126 || rc === 127 || rc >= 128` → crash) and the runner's `pre.exitCode !== 0` / `post.exitCode !== 0` guards already convert to a `checks`-stage indeterminate. Also surface the child's stderr in the result so triage sees bash's "command not found" instead of silence.

**Files:**
- Modify: `src/checks/index.ts` (the `spawnSync` invocation ~line 96; `RunPhaseResult` interface ~line 47)
- Test: `test/checks.test.ts`

**Interfaces:**
- Consumes: existing `runPhase(args: RunPhaseArgs): Promise<RunPhaseResult>`.
- Produces: `RunPhaseResult` gains `readonly stderr: string` (the child's captured stderr, possibly empty). Exit-code semantics unchanged for callers: nonzero = crash. Task 2's runner change consumes `stderr`.

- [ ] **Step 1: Write the failing tests**

Append to `test/checks.test.ts` (uses the existing `checksShWith` helper at the top of that file):

```typescript
// PRI-2494: a crashed verb MID-phase must abort the phase (previously the last
// command's rc masked it — the false-pass hole).
test('a typo’d verb mid-phase crashes the phase even when later checks pass', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  writeFileSync(join(workdir, 'present.txt'), 'x');
  const checksSh = checksShWith(
    'pre() {\n  file-exsts present.txt\n  file-exists present.txt\n}\npost() { :; }\n',
  );
  const { records, exitCode, stderr } = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    repoRoot: REPO,
  });
  expect(exitCode).toBe(127);
  // The passing check after the typo never ran: the phase aborted at the crash.
  expect(records).toHaveLength(0);
  // Triage evidence: bash's diagnosis is surfaced, not discarded.
  expect(stderr).toContain('file-exsts');
});

// An HONEST failure (verb ran, assertion false, rc 1) must NOT abort the phase:
// later checks still run and the phase is clean (rc 0, both records present).
test('an honest check failure mid-phase does not abort the phase', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  writeFileSync(join(workdir, 'present.txt'), 'x');
  const checksSh = checksShWith(
    'pre() {\n  file-exists nope.txt\n  file-exists present.txt\n}\npost() { :; }\n',
  );
  const { records, exitCode } = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    repoRoot: REPO,
  });
  expect(exitCode).toBe(0);
  expect(records).toHaveLength(2);
  expect(records[0]?.passed).toBe(false);
  expect(records[1]?.passed).toBe(true);
});

// `not` of an honest fail passes and continues (not’s exit-1-never-127 contract
// must survive the trap).
test('not-inverted checks still flow through a trapped phase', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  writeFileSync(join(workdir, 'present.txt'), 'x');
  const checksSh = checksShWith(
    'pre() {\n  not file-exists nope.txt\n  file-exists present.txt\n}\npost() { :; }\n',
  );
  const { records, exitCode } = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    repoRoot: REPO,
  });
  expect(exitCode).toBe(0);
  expect(records).toHaveLength(2);
});
```

- [ ] **Step 2: Run tests to verify the first fails and the guard tests pass**

Run: `bun test test/checks.test.ts`
Expected: the mid-phase-typo test FAILS (`exitCode` 0 ≠ 127, records length 1 ≠ 0; `stderr` property missing → TypeScript error first — that's the same failure signal). The two continuation tests may pass already; they are regression guards for Step 3.

- [ ] **Step 3: Implement the trap + stderr surfacing**

In `src/checks/index.ts`:

Add `stderr` to the result interface:

```typescript
export interface RunPhaseResult {
  readonly records: readonly CheckRecord[];
  /**
   * Crash-aware exit code: a tool that fails its assertion (rc 1) is an ok phase
   * if it emitted a record, but a bash crash (command-not-found / signal / no
   * records) propagates as nonzero.
   */
  readonly exitCode: number;
  /**
   * The phase's captured stderr. On a crash this carries bash's diagnosis
   * (e.g. "file-exsts: command not found") for the composer's final_reason.
   */
  readonly stderr: string;
}
```

Change the `bash -c` script to install the crash-band ERR trap before sourcing (replace the existing `['-c', …]` argv element):

```typescript
    // Crash-band discipline (PRI-2494): a check verb that CRASHES (126/127/
    // signal — e.g. a typo'd verb name) anywhere in the phase must abort the
    // phase with that rc, not be masked by a later command's rc 0. An HONEST
    // check failure (rc 1) must flow on so later checks still run and emit
    // records. `set -E` propagates the ERR trap into the pre()/post() function
    // bodies; the trap re-raises only crash-band statuses.
    const phaseScript =
      `set -E; trap 'rc=$?; if [ "$rc" -ge 126 ]; then exit "$rc"; fi' ERR; ` +
      `source '${prelude}'; source '${args.checksSh}'; ${args.phase}`;
    const proc = spawnSync('bash', ['-c', phaseScript], {
```

Thread stderr through every return in `runPhase` (the signal-kill return and the normal return):

```typescript
    const stderr = proc.stderr ?? '';
    // … (existing signal handling)
    if (proc.signal) {
      return { records, exitCode: 128 + signalNumber(proc.signal), stderr };
    }
    // … (existing rc heuristic unchanged)
    return { records, exitCode, stderr };
```

- [ ] **Step 4: Run the test file, then the full suite**

Run: `bun test test/checks.test.ts`
Expected: all PASS (new tests + every pre-existing runPhase test — the existing "bash crash (unbound command) with no records" test at ~line 113 must still see 127).

Run: `bun test`
Expected: PASS. If any runner test asserted on `RunPhaseResult` shape, fix the destructuring (additive field; none expected to break).

- [ ] **Step 5: Surface the crash stderr in the runner's final_reason**

In `src/runner/index.ts`, the two crash guards (~line 1179 and ~line 1586) currently compose `pre-checks crashed (exit N)` / `post-checks crashed (exit N)`. Append the first stderr line so triage names the broken verb. Change both:

```typescript
  if (pre.exitCode !== 0) {
    return compose({
      gauntlet: null,
      checks: [...pre.records],
      captureEmpty: false,
      error: {
        stage: 'checks',
        message: `pre-checks crashed (exit ${pre.exitCode})${crashHint(pre.stderr)}`,
      },
    });
  }
```

```typescript
  if (post.exitCode !== 0) {
    return compose({
      gauntlet,
      checks: [...pre.records, ...post.records],
      captureEmpty,
      error: {
        stage: 'checks',
        message: `post-checks crashed (exit ${post.exitCode})${crashHint(post.stderr)}`,
      },
    });
  }
```

Add the helper near the other small helpers in `src/runner/index.ts` (e.g. below `scenarioName`):

```typescript
// First non-empty stderr line of a crashed check phase, as a ": …" suffix for
// the final_reason (e.g. bash's "file-exsts: command not found"). Empty stderr
// contributes nothing.
function crashHint(stderr: string): string {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? `: ${line.slice(0, 200)}` : '';
}
```

- [ ] **Step 6: Add a runner-level test for the hint**

Append to `test/checks.test.ts` (keeps the coverage at the runPhase seam; the runner guards consume the same field):

```typescript
test('crash stderr is captured for the final_reason hint', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  const checksSh = checksShWith('pre() {\n  no-such-verb-xyz\n}\npost() { :; }\n');
  const { exitCode, stderr } = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    repoRoot: REPO,
  });
  expect(exitCode).toBe(127);
  expect(stderr).toContain('no-such-verb-xyz');
});
```

Run: `bun test test/checks.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/drewritter/prime-rad/superpowers-evals
git add src/checks/index.ts src/runner/index.ts test/checks.test.ts
git commit -m "fix(checks): abort a phase on any crash-band verb exit, not just the last

A typo'd/crashed check verb mid-phase was masked by the phase's final
exit status, silently dropping the check from the verdict (false-pass
hole, PRI-2494). set -E + a crash-band ERR trap aborts the phase at the
crash while honest rc-1 failures still flow. Phase stderr is now
captured and surfaced in the crashed final_reason."
```

---

### Task 2: FS-verb arity gates + trailing-`**` glob fix

Two vacuous-pass holes in `src/check/fs-verbs.ts`: (a) `file-exists` / `file-contains` / `command-succeeds` with missing or empty args default to `''` and can pass vacuously (e.g. `command-succeeds ""` runs `bash -c ''` → rc 0 → PASS); the transcript side already refuses exactly this via its `REQUIRED_ARGS` table (src/check/transcript-dispatch.ts:34). (b) `globStar` on a trailing-`**` pattern (`docs/**`) strips the stars to a suffix of `''`/`'docs/'`, which never matches — `file-exists 'docs/**'` fails even when docs/ has children.

**Files:**
- Modify: `src/check/fs-verbs.ts` (arity gate in the three verbs; `globStar` ~line 144)
- Test: `test/check-tool.test.ts`

**Interfaces:**
- Consumes: existing `CheckOutcome` / `broken()` helpers in fs-verbs.ts; the CLI's existing broken→127 mapping (src/cli/check-tool.ts:72).
- Produces: no signature changes. New behavior contract: the three verbs return `{broken:true}` on missing/empty required args; `not` refuses to invert them (existing rule 3); `file-exists 'dir/**'` matches iff `dir/` has any descendant.

- [ ] **Step 1: Write the failing tests**

Append to `test/check-tool.test.ts` (that file already has helpers for invoking verbs — follow its existing per-verb test style; the assertions below use the pure functions directly):

```typescript
import {
  verbCommandSucceeds,
  verbFileContains,
  verbFileExists,
} from '../src/check/fs-verbs.ts';

// PRI-2494 arity gates: a missing/empty required arg is a BROKEN check (127
// band), never a vacuous pass. Mirrors transcript-dispatch's REQUIRED_ARGS.
test('file-exists with no args is broken, not a pass', () => {
  const ctx = { cwd: mkdtempSync(join(tmpdir(), 'wd-')), env: () => undefined };
  for (const args of [[], ['']]) {
    const r = verbFileExists(args, ctx);
    expect(r.broken).toBe(true);
    expect(r.passed).toBe(false);
  }
});

test('file-contains with a missing path or pattern is broken', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wd-'));
  writeFileSync(join(cwd, 'f.txt'), 'hello\n');
  const ctx = { cwd, env: () => undefined };
  for (const args of [[], ['f.txt'], ['f.txt', ''], ['', 'hello']]) {
    const r = verbFileContains(args, ctx);
    expect(r.broken).toBe(true);
  }
  // Two real args still work.
  expect(verbFileContains(['f.txt', 'hello'], ctx).passed).toBe(true);
});

test('command-succeeds with a missing/empty command is broken (bash -c "" would pass)', () => {
  const ctx = { cwd: mkdtempSync(join(tmpdir(), 'wd-')), env: () => undefined };
  for (const args of [[], ['']]) {
    const r = verbCommandSucceeds(args, ctx);
    expect(r.broken).toBe(true);
  }
});

// PRI-2494 glob fix: a trailing-`**` matches any descendant of the prefix dir.
test('file-exists with a trailing-** glob matches directory descendants', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wd-'));
  mkdirSync(join(cwd, 'docs', 'sub'), { recursive: true });
  writeFileSync(join(cwd, 'docs', 'sub', 'a.md'), 'x');
  const ctx = { cwd, env: () => undefined };
  expect(verbFileExists(['docs/**'], ctx).passed).toBe(true);
  // An empty dir has no descendants: no match.
  mkdirSync(join(cwd, 'empty'));
  expect(verbFileExists(['empty/**'], ctx).passed).toBe(false);
});
```

(Add `mkdirSync` to the test file's `node:fs` import if absent.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/check-tool.test.ts`
Expected: FAIL — `broken` is `undefined` on the arity cases; the trailing-`**` case returns `passed: false`.

- [ ] **Step 3: Implement the gates and the glob fix**

In `src/check/fs-verbs.ts`:

`verbFileExists` (~line 67):

```typescript
export function verbFileExists(
  args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const pattern = args[0] ?? '';
  if (pattern === '') {
    // A missing/empty pattern must not vacuously resolve; mirrors the
    // transcript verbs' REQUIRED_ARGS discipline (PRI-2494).
    return broken('file-exists: needs a <glob> argument');
  }
  const matches = globMatch(pattern, ctx.cwd);
  if (matches.length > 0) {
    return pass();
  }
  return fail(`no path matched: ${pattern}`);
}
```

`verbFileContains` (~line 249):

```typescript
export function verbFileContains(
  args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const path = args[0] ?? '';
  const pattern = args[1] ?? '';
  if (path === '' || pattern === '') {
    return broken('file-contains: needs <path> and <ere>');
  }
  // … (rest unchanged)
```

`verbCommandSucceeds` (~line 274):

```typescript
export function verbCommandSucceeds(
  args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const command = args[0] ?? '';
  if (command === '') {
    // `bash -c ''` exits 0: an empty command would vacuously pass.
    return broken('command-succeeds: needs a <command> argument');
  }
  // … (rest unchanged)
```

`globStar` (~line 144) — handle the trailing-`**` (no `**/` segment) by matching every descendant of the prefix:

```typescript
function globStar(pattern: string, cwd: string): string[] {
  // `dir/**` (trailing recursive glob, no `**/`): every descendant of dir/.
  if (/(^|\/)\*\*$/.test(pattern)) {
    let prefix = pattern.slice(0, -2).replace(/\/$/, '');
    if (prefix === '') prefix = '.';
    const baseAbs = resolve(cwd, prefix);
    if (!existsSync(baseAbs)) return [];
    return walk(baseAbs, prefix);
  }
  // … (existing `**/` logic unchanged)
```

- [ ] **Step 4: Run the tests and the full suite**

Run: `bun test test/check-tool.test.ts && bun test`
Expected: PASS everywhere. Existing tests exercising `file-exists nonexistent.txt` (honest fail) must stay honest fails, not broken.

- [ ] **Step 5: Survey no scenario regresses**

Every existing checks.sh/setup.sh call site passes literal non-empty args, but verify:

Run: `grep -rn "file-exists\s*$\|file-contains\s*$\|command-succeeds\s*$" scenarios/*/checks.sh scenarios/*/setup.sh; echo "rc=$? (1 = no bare calls, good)"`
Expected: `rc=1` (no matches — no scenario calls these verbs with zero args).

- [ ] **Step 6: Commit**

```bash
git add src/check/fs-verbs.ts test/check-tool.test.ts
git commit -m "fix(check): arity-gate file-exists/file-contains/command-succeeds; fix trailing-** glob

A missing or empty-expanded required arg vacuously passed (e.g.
command-succeeds \"\" ran bash -c '' -> rc 0). The verbs now return
broken (127 band, non-invertible) exactly like the transcript verbs'
REQUIRED_ARGS discipline. Trailing-** globs (docs/**) now match
directory descendants instead of never matching (PRI-2494)."
```

---

### Task 3: Static verb-name validation in `quorum check`

`checkScenario` (src/scaffold.ts) validates setup-helper names against `KNOWN_HELPER_NAMES` but never validates the check verbs in checks.sh — a typo'd verb only surfaces at run time (and before Task 1, not even then). Add a lint that extracts each check statement's leading token from `pre()`/`post()` bodies and validates it against the known-command vocabulary: `FS_VERBS` keys + `not` + `check-transcript` + `setup-helpers` + `inject-user-preference` (the prelude's functions) + bash builtins/keywords actually used in scenario bodies (`:`, `true`, `local`, `if/then/else/fi`, `for/do/done`, `[`, `[[`, etc.).

Also validate `check-transcript <sub>` subverbs and `not <inner>` inner names. Keep it a conservative lint: only lines whose first token LOOKS like a check invocation are judged; anything inside `$(...)`, quoted strings, or continuation lines is out of scope (bash parsing is not the goal; catching typo'd verbs is).

**Files:**
- Modify: `src/scaffold.ts` (new `validateCheckVerbs` wired into `validateChecksSh`)
- Modify: `src/check/transcript-dispatch.ts` (export the verb vocabulary)
- Test: `test/scaffold.test.ts`

**Interfaces:**
- Consumes: `FS_VERBS` from `src/check/dispatch.ts` (`Object.keys`); new export from transcript-dispatch.
- Produces: `export const TRANSCRIPT_VERBS: ReadonlySet<string>` in `src/check/transcript-dispatch.ts` (derived from the existing `REQUIRED_ARGS` table + `'tool-arg-match'`). `checkScenario` problems gain entries shaped `checks.sh:<line>: unknown check verb '<tok>'`.

- [ ] **Step 1: Write the failing tests**

Append to `test/scaffold.test.ts` (uses its existing `scenariosRoot()` + `newScenario` helpers):

```typescript
// PRI-2494: quorum check validates check-verb names statically, so a typo'd
// verb is caught at authoring time instead of vanishing at run time.
function scenarioWithChecks(checksBody: string): string {
  const dir = newScenario(join(scenariosRoot(), 'v-scn'));
  writeFileSync(join(dir, 'checks.sh'), checksBody);
  return dir;
}

test('checkScenario flags a typo’d verb inside pre()', () => {
  const dir = scenarioWithChecks(
    'pre() {\n    file-exsts foo.txt\n}\n\npost() {\n    file-exists foo.txt\n}\n',
  );
  const problems = checkScenario(dir);
  expect(problems.some((p) => p.includes("unknown check verb 'file-exsts'"))).toBe(true);
});

test('checkScenario flags an unknown check-transcript subverb and not-inner', () => {
  const dir = scenarioWithChecks(
    'pre() {\n    git-repo\n}\n\npost() {\n    check-transcript skil-called superpowers:tdd\n    not file-exsts foo\n}\n',
  );
  const problems = checkScenario(dir);
  expect(
    problems.some((p) => p.includes("unknown check-transcript verb 'skil-called'")),
  ).toBe(true);
  expect(problems.some((p) => p.includes("unknown check verb 'file-exsts'"))).toBe(true);
});

test('checkScenario accepts real verbs, not/check-transcript, helpers, and shell control flow', () => {
  const dir = scenarioWithChecks(
    [
      'pre() {',
      '    git-repo',
      '    git-branch main',
      '    requires-tool jq',
      '    if [ -f maybe.txt ]; then',
      '        file-contains maybe.txt hello',
      '    fi',
      '}',
      '',
      'post() {',
      '    check-transcript skill-called superpowers:test-driven-development',
      '    not check-transcript tool-called NotebookEdit',
      '    local n=1',
      '    :',
      '}',
      '',
    ].join('\n'),
  );
  const problems = checkScenario(dir);
  expect(problems.filter((p) => p.includes('unknown check'))).toEqual([]);
});

// The whole active corpus must stay valid: the lint is additive, zero
// false positives on shipped scenarios.
test('every active scenario passes the verb lint', () => {
  const scenarios = join(import.meta.dir, '..', 'scenarios');
  for (const name of readdirSync(scenarios)) {
    const dir = join(scenarios, name);
    if (!statSync(dir).isDirectory()) continue;
    const problems = checkScenario(dir).filter((p) => p.includes('unknown check'));
    expect({ scenario: name, problems }).toEqual({ scenario: name, problems: [] });
  }
});
```

(Add `readdirSync` to the test file's `node:fs` import if absent.)

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `bun test test/scaffold.test.ts`
Expected: the two flag tests FAIL (no problems emitted); the acceptance + corpus tests PASS vacuously (also no problems). That asymmetry is fine — the flag tests are the red.

- [ ] **Step 3: Export the transcript vocabulary**

In `src/check/transcript-dispatch.ts`, after the `REQUIRED_ARGS` table:

```typescript
// The full transcript-verb vocabulary, for static validation (quorum check).
// Derived from REQUIRED_ARGS (every verb with an arity entry) plus
// tool-arg-match, whose arity is option-shaped and validated separately above.
export const TRANSCRIPT_VERBS: ReadonlySet<string> = new Set([
  ...Object.keys(REQUIRED_ARGS),
  'tool-arg-match',
]);
```

- [ ] **Step 4: Implement the lint in scaffold.ts**

In `src/scaffold.ts`, add imports:

```typescript
import { FS_VERBS } from './check/dispatch.ts';
import { TRANSCRIPT_VERBS } from './check/transcript-dispatch.ts';
```

Add below `validateChecksSh`:

```typescript
// Leading tokens that are legitimate in a checks.sh body but are not check
// verbs: the prelude's non-verb functions, bash keywords/builtins seen in
// scenario bodies, and test/grouping syntax. A token starting with a quote,
// $, (, or containing = (assignment) is skipped as not-a-command.
const CHECKS_SH_ALLOWED_TOKENS: ReadonlySet<string> = new Set([
  'not',
  'check-transcript',
  'setup-helpers',
  'inject-user-preference',
  ':',
  'true',
  'false',
  'local',
  'return',
  'echo',
  'cd',
  'export',
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  '[',
  '[[',
  '{',
  '}',
  '!',
]);

// Conservative static verb lint over pre()/post() bodies (PRI-2494): the
// FIRST token of each body line must be a known check verb, an allowed
// shell token, or obviously not a command (assignment, expansion, quote).
// `not <inner>` recurses one level; `check-transcript <sub>` validates the
// subverb. This is a typo catcher, not a bash parser: unknown tokens are
// reported, everything structurally ambiguous is let through.
function validateCheckVerbs(text: string): string[] {
  const problems: string[] = [];
  const lines = pySplitlines(text);
  let inFn = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const isFnDecl = /^(pre|post)\s*\(\)/.test(s);
    const opens = countChar(s, '{');
    const closes = countChar(s, '}');
    if (isFnDecl) {
      inFn = Math.max(0, inFn + opens - closes);
      continue;
    }
    if (s === '{') {
      inFn += 1;
      continue;
    }
    if (s === '}') {
      inFn = Math.max(0, inFn - 1);
      continue;
    }
    if (inFn === 0) continue; // top-level lines are validateChecksSh's problem
    problems.push(...lintCommandLine(s, i + 1));
    if (inFn > 0) inFn = Math.max(0, inFn + opens - closes);
  }
  return problems;
}

// Lint one in-function line's leading command token (recursing through `not`).
function lintCommandLine(s: string, lineNo: number): string[] {
  const tokens = s.split(/\s+/);
  const tok = tokens[0] ?? '';
  // Not command-shaped: assignments, expansions, quotes, subshells, redirects.
  if (
    tok === '' ||
    tok.includes('=') ||
    /^["'$(<>&|;]/.test(tok)
  ) {
    return [];
  }
  if (tok === 'not') {
    // Validate the inner verb the same way (one level; `not not x` is not used).
    return lintCommandLine(tokens.slice(1).join(' '), lineNo);
  }
  if (tok === 'check-transcript') {
    const sub = tokens[1] ?? '';
    if (sub !== '' && !sub.startsWith('$') && !TRANSCRIPT_VERBS.has(sub)) {
      return [
        `checks.sh:${lineNo}: unknown check-transcript verb '${sub}'`,
      ];
    }
    return [];
  }
  if (tok in FS_VERBS || CHECKS_SH_ALLOWED_TOKENS.has(tok)) {
    return [];
  }
  return [`checks.sh:${lineNo}: unknown check verb '${tok}'`];
}
```

Wire it into `validateChecksSh` just before the final `return problems;` (after the existing `$QUORUM_WORKDIR` lint):

```typescript
  problems.push(...validateCheckVerbs(text));
```

- [ ] **Step 5: Run the tests; iterate on the allowlist against the corpus**

Run: `bun test test/scaffold.test.ts`
Expected: PASS, including the whole-corpus test. If the corpus test reports an unknown token that is legitimate shell (e.g. a `grep` or `wc` pipeline in some scenario), add that exact token to `CHECKS_SH_ALLOWED_TOKENS` — extend the allowlist, never weaken the verb match. Every addition must come from a real scenario line, verified by reading it.

Run: `bun run quorum check`
Expected: exit 0, no problems on the active corpus.

- [ ] **Step 6: Run the full check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add src/scaffold.ts src/check/transcript-dispatch.ts test/scaffold.test.ts
git commit -m "feat(check): quorum check statically validates check-verb names

checks.sh bodies are linted against the real verb vocabularies
(FS_VERBS keys, the transcript REQUIRED_ARGS-derived set, prelude
functions) so a typo'd verb fails at authoring time instead of
vanishing at run time. Conservative token lint: assignments,
expansions, and shell control flow are ignored (PRI-2494)."
```

---

### Task 4: Run provenance in verdict.json

A verdict cannot name what was under test: no superpowers rev, no agent CLI version, no gauntlet or harness rev. Stamp a `provenance` block at the runner's single identity-stamping site (`runScenario`, src/runner/index.ts ~line 853). All fields nullable-by-absence; failures to probe NEVER fail a run (best-effort, `null` on any error). Renderers ignore it for now — the block exists for triage and #1934-style bisection.

**Files:**
- Create: `src/runner/provenance.ts`
- Modify: `src/contracts/verdict.ts` (optional `provenance` field)
- Modify: `src/runner/index.ts` (stamp in the `identified` literal, ~line 853)
- Test: `test/provenance.test.ts` (new)

**Interfaces:**
- Consumes: `getEnv` from `src/env.ts`; `spawnSync` for git/CLI probes.
- Produces:

```typescript
// src/runner/provenance.ts
export interface RunProvenance {
  superpowers_rev: string | null;      // git HEAD of $SUPERPOWERS_ROOT
  superpowers_dirty: boolean | null;   // uncommitted changes in that checkout
  harness_rev: string | null;          // git HEAD of the quorum repo itself
  agent_cli_version: string | null;    // `<binary> --version` first line
  gauntlet_version: string | null;     // `gauntlet --version` first line
}
export function collectProvenance(args: {
  repoRoot: string;
  agentBinary: string | null;
}): RunProvenance;
```

- [ ] **Step 1: Write the failing tests**

Create `test/provenance.test.ts`:

```typescript
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectProvenance } from '../src/runner/provenance.ts';

const REPO = resolve(import.meta.dir, '..');

function git(cwd: string, ...args: string[]): string {
  const p = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return (p.stdout ?? '').trim();
}

// A tiny throwaway git repo standing in for $SUPERPOWERS_ROOT.
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sp-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'x'], { cwd: dir });
  return dir;
}

test('collectProvenance reads superpowers rev + dirty flag from SUPERPOWERS_ROOT', () => {
  const sproot = makeRepo();
  const prev = process.env['SUPERPOWERS_ROOT'];
  process.env['SUPERPOWERS_ROOT'] = sproot;
  try {
    const p = collectProvenance({ repoRoot: REPO, agentBinary: null });
    expect(p.superpowers_rev).toBe(git(sproot, 'rev-parse', 'HEAD'));
    expect(p.superpowers_dirty).toBe(false);
    writeFileSync(join(sproot, 'dirt.txt'), 'x');
    expect(collectProvenance({ repoRoot: REPO, agentBinary: null }).superpowers_dirty).toBe(true);
  } finally {
    if (prev === undefined) delete process.env['SUPERPOWERS_ROOT'];
    else process.env['SUPERPOWERS_ROOT'] = prev;
  }
});

test('collectProvenance reads the harness rev from repoRoot', () => {
  const p = collectProvenance({ repoRoot: REPO, agentBinary: null });
  expect(p.harness_rev).toBe(git(REPO, 'rev-parse', 'HEAD'));
});

test('collectProvenance probes the agent CLI version via --version', () => {
  // A fake agent binary on a scoped PATH.
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  const fake = join(bin, 'fake-agent');
  writeFileSync(fake, '#!/bin/sh\necho "fake-agent 9.9.9"\n');
  spawnSync('chmod', ['+x', fake]);
  const prevPath = process.env['PATH'];
  process.env['PATH'] = `${bin}:${prevPath ?? ''}`;
  try {
    const p = collectProvenance({ repoRoot: REPO, agentBinary: 'fake-agent' });
    expect(p.agent_cli_version).toBe('fake-agent 9.9.9');
  } finally {
    process.env['PATH'] = prevPath ?? '';
  }
});

test('collectProvenance never throws: every probe failure is a null field', () => {
  const prev = process.env['SUPERPOWERS_ROOT'];
  process.env['SUPERPOWERS_ROOT'] = '/nonexistent/definitely-not-a-repo';
  try {
    const p = collectProvenance({
      repoRoot: mkdtempSync(join(tmpdir(), 'notrepo-')),
      agentBinary: 'definitely-not-a-binary-xyz',
    });
    expect(p.superpowers_rev).toBe(null);
    expect(p.superpowers_dirty).toBe(null);
    expect(p.harness_rev).toBe(null);
    expect(p.agent_cli_version).toBe(null);
  } finally {
    if (prev === undefined) delete process.env['SUPERPOWERS_ROOT'];
    else process.env['SUPERPOWERS_ROOT'] = prev;
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/provenance.test.ts`
Expected: FAIL — module `src/runner/provenance.ts` does not exist.

- [ ] **Step 3: Implement collectProvenance**

Create `src/runner/provenance.ts`:

```typescript
// Best-effort run provenance (PRI-2494): what exactly was under test. Every
// probe is fallible and independent — a probe failure yields null for that
// field and MUST NOT fail the run. Stamped into verdict.json by runScenario;
// renderers may ignore it. It exists so a run dir can answer "which
// superpowers rev / agent CLI / gauntlet produced this verdict" (triage,
// longitudinal baselines, commit-per-skill bisection).

import { spawnSync } from 'node:child_process';
import { getEnv } from '../env.ts';

export interface RunProvenance {
  superpowers_rev: string | null;
  superpowers_dirty: boolean | null;
  harness_rev: string | null;
  agent_cli_version: string | null;
  gauntlet_version: string | null;
}

export function collectProvenance(args: {
  repoRoot: string;
  agentBinary: string | null;
}): RunProvenance {
  const sproot = getEnv('SUPERPOWERS_ROOT');
  return {
    superpowers_rev: sproot ? gitRev(sproot) : null,
    superpowers_dirty: sproot ? gitDirty(sproot) : null,
    harness_rev: gitRev(args.repoRoot),
    agent_cli_version: args.agentBinary
      ? versionLine(args.agentBinary)
      : null,
    gauntlet_version: versionLine('gauntlet'),
  };
}

function gitRev(cwd: string): string | null {
  const out = run('git', ['-C', cwd, 'rev-parse', 'HEAD']);
  return out === null ? null : out.trim() || null;
}

function gitDirty(cwd: string): boolean | null {
  const out = run('git', ['-C', cwd, 'status', '--porcelain']);
  return out === null ? null : out.trim() !== '';
}

// First line of `<binary> --version`; null when the binary is missing,
// exits nonzero, or prints nothing.
function versionLine(binary: string): string | null {
  const out = run(binary, ['--version']);
  if (out === null) return null;
  const line = out.split('\n')[0]?.trim() ?? '';
  return line === '' ? null : line;
}

// Run a probe; null on spawn error or nonzero exit. 10s timeout so a hung
// probe cannot stall the verdict write.
function run(cmd: string, args: string[]): string | null {
  try {
    const p = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });
    if (p.error || (p.status ?? 1) !== 0) return null;
    return p.stdout ?? '';
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the provenance tests**

Run: `bun test test/provenance.test.ts`
Expected: PASS (4/4). Note `gauntlet_version` will be null on machines without gauntlet — no test asserts otherwise.

- [ ] **Step 5: Add the schema field and stamp it in runScenario**

In `src/contracts/verdict.ts`, add below the `os` field in `FinalVerdictSchema`:

```typescript
  // Best-effort provenance (PRI-2494): what was under test. Optional so old
  // verdicts parse; every inner field is nullable (probe failures).
  provenance: z
    .object({
      superpowers_rev: z.string().nullable(),
      superpowers_dirty: z.boolean().nullable(),
      harness_rev: z.string().nullable(),
      agent_cli_version: z.string().nullable(),
      gauntlet_version: z.string().nullable(),
    })
    .optional(),
```

In `src/runner/index.ts`:
- Import: `import { collectProvenance } from './provenance.ts';`
- In `runScenario`, the agent binary is not yet known at the `identified` literal (config load happens inside `runInner`, which may itself have failed). Probe it from the agent yaml best-effort — add just above the `identified` literal (~line 853):

```typescript
  // Best-effort provenance stamp (PRI-2494). The binary name comes from the
  // agent yaml when it loads; a broken yaml just means a null CLI version.
  let agentBinary: string | null = null;
  try {
    agentBinary = loadAgentConfig(a.codingAgentsDir, a.codingAgent).binary;
  } catch {
    agentBinary = null;
  }
  const provenance = collectProvenance({
    repoRoot: repoRoot(),
    agentBinary,
  });
```

and add to the `identified` literal:

```typescript
  const identified: FinalVerdict = {
    ...verdict,
    scenario,
    coding_agent: a.codingAgent,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    credential: credentialName ?? 'none',
    os: a.os ?? 'linux',
    provenance,
  };
```

(`repoRoot` is imported from `../paths.ts`; check the file's existing imports — `loadAgentConfig` is already imported at line 60.)

- [ ] **Step 6: Extend a runner guard test to see the stamp**

Append to `test/runner-guards.test.ts`:

```typescript
// PRI-2494: even a guard-tripped (setup-indeterminate) verdict carries the
// provenance block — the stamp lives at the single identity site.
test('verdict.json carries a provenance block with the harness rev', async () => {
  const scenarioDir = makeScenarioDir({ omitChecks: true });
  const { runDir } = await runGuard({ scenarioDir });
  const persisted = JSON.parse(
    readFileSync(join(runDir, 'verdict.json'), 'utf8'),
  );
  expect(persisted.provenance).toBeDefined();
  expect(typeof persisted.provenance.harness_rev).toBe('string');
  expect(persisted.provenance.harness_rev.length).toBeGreaterThan(7);
});
```

- [ ] **Step 7: Run the full suite and commit**

Run: `bun test && bun run typecheck`
Expected: PASS. (The dashboard/show readers parse verdicts through `FinalVerdictSchema`; the field is optional so nothing else changes.)

```bash
git add src/runner/provenance.ts src/contracts/verdict.ts src/runner/index.ts test/provenance.test.ts test/runner-guards.test.ts
git commit -m "feat(runner): stamp best-effort run provenance into verdict.json

verdict.json now records superpowers rev + dirty flag, harness rev,
agent CLI version, and gauntlet version — so a run dir can name what
was under test (triage, baselines, commit-per-skill bisection). Every
probe is independent and failure-isolated: nulls, never a failed run
(PRI-2494)."
```

---

### Task 5: Claude launcher env isolation (env -i allowlist)

The claude launcher (`coding-agents/claude-context/launch-agent`) strips only `CLAUDECODE`/`CLAUDE_CODE_SESSION_ID` and otherwise inherits the full host env — so host `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, or `CLAUDE_CODE_USE_BEDROCK` silently reconfigure the agent under test. Convert it to the `env -i` + explicit-allowlist pattern proven in the opencode/serf launchers, preserving the deliberate vars: the throwaway-home fragment (`$QUORUM_HOME_ENV`), `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`, and `ANTHROPIC_API_KEY` from the sourced `$CLAUDE_ENV_FILE`. Under `env -i` no nested-session vars survive, so the `-u` strips become redundant (kept out).

The launcher is a text template substituted by `populateContextDir`; test it by substituting a real template into a temp context dir and executing it with a fake `claude` binary on the allowlisted PATH that dumps its env.

**Files:**
- Modify: `coding-agents/claude-context/launch-agent`
- Test: `test/launcher-env-isolation.test.ts` (new)

**Interfaces:**
- Consumes: `populateContextDir` from `src/runner/context.ts`; `homeEnvSubstitutions` from `src/runner/index.ts` (both already exported).
- Produces: no TS interface change. Behavior contract: the claude child env contains exactly PATH/TERM/LANG, the home fragment (HOME, XDG_*, TMPDIR), `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`, and `ANTHROPIC_API_KEY`; host `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_*` never reach it.

- [ ] **Step 1: Write the failing test**

Create `test/launcher-env-isolation.test.ts`:

```typescript
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { populateContextDir } from '../src/runner/context.ts';
import { homeEnvSubstitutions } from '../src/runner/index.ts';

const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

// Substitute a real launcher template into a temp "run dir" and return the
// installed launcher path plus its env-file/home fixture paths.
function installLauncher(agent: 'claude' | 'codex'): {
  launcher: string;
  binDir: string;
  envDump: string;
} {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const home = join(runDir, 'home');
  mkdirSync(home, { recursive: true });
  const cwd = join(runDir, 'workdir');
  mkdirSync(cwd);

  // A fake agent binary that dumps its environment and exits.
  const binDir = mkdtempSync(join(tmpdir(), 'bin-'));
  const envDump = join(runDir, 'env-dump.txt');
  const fake = join(binDir, agent === 'claude' ? 'claude' : 'codex');
  writeFileSync(fake, `#!/bin/sh\nenv > '${envDump}'\n`);
  chmodSync(fake, 0o755);

  // The env file each launcher sources.
  const envFile = join(runDir, `${agent}.env`);
  writeFileSync(
    envFile,
    agent === 'claude'
      ? "ANTHROPIC_API_KEY='sk-test-launcher'\n"
      : "CODEX_PROVIDER_API_KEY='sk-codex-test'\n",
  );

  const substitutions: Record<string, string> = {
    $QUORUM_AGENT_CWD: cwd,
    $SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sp-')),
    ...homeEnvSubstitutions(home),
    ...(agent === 'claude'
      ? { $CLAUDE_ENV_FILE: envFile, $CLAUDE_MODEL: 'test-model' }
      : { $CODEX_ENV_FILE: envFile }),
  };
  populateContextDir({
    codingAgentsDir: REAL_CODING_AGENTS,
    codingAgent: agent,
    runDir,
    substitutions,
    required: true,
  });
  return {
    launcher: join(runDir, 'gauntlet-agent', 'context', 'launch-agent'),
    binDir,
    envDump,
  };
}

// Parse an `env` dump into a map.
function parseEnvDump(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

// Hostile host env every launcher must scrub (PRI-2494).
const HOSTILE = {
  ANTHROPIC_BASE_URL: 'http://evil.example',
  ANTHROPIC_AUTH_TOKEN: 'evil-token',
  ANTHROPIC_MODEL: 'evil-model',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'host-session',
  OPENAI_API_KEY: 'sk-host-openai',
  OPENAI_BASE_URL: 'http://evil-openai.example',
  OPENAI_ORG_ID: 'evil-org',
  SOME_RANDOM_HOST_VAR: 'leaked',
};

function launchAndDump(agent: 'claude' | 'codex'): Record<string, string> {
  const { launcher, binDir, envDump } = installLauncher(agent);
  const proc = spawnSync('bash', [launcher], {
    encoding: 'utf8',
    env: {
      ...HOSTILE,
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: '/host/home',
    },
  });
  expect(proc.status).toBe(0);
  return parseEnvDump(envDump);
}

test('claude launcher: hostile host env never reaches the agent', () => {
  const env = launchAndDump('claude');
  for (const key of Object.keys(HOSTILE)) {
    expect({ key, value: env[key] }).toEqual({ key, value: undefined });
  }
  // The deliberate vars DO reach it.
  expect(env['ANTHROPIC_API_KEY']).toBe('sk-test-launcher');
  expect(env['CLAUDE_CODE_FORCE_SESSION_PERSISTENCE']).toBe('1');
  expect(env['HOME']).not.toBe('/host/home');
  expect(env['HOME']).toContain('home');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/launcher-env-isolation.test.ts`
Expected: FAIL — `SOME_RANDOM_HOST_VAR`, `ANTHROPIC_BASE_URL`, etc. survive into the dump (current launcher inherits the host env).

- [ ] **Step 3: Rewrite the claude launcher on the env -i pattern**

Replace the `set -euo pipefail` block onward in `coding-agents/claude-context/launch-agent` (keep the header comments, updating the manual-command example; drop the now-redundant `-u CLAUDECODE -u CLAUDE_CODE_SESSION_ID` rationale paragraph in favor of a note that `env -i` supersedes the strips):

```bash
set -euo pipefail
cd "$QUORUM_AGENT_CWD" || { echo "launch-agent: cannot cd to $QUORUM_AGENT_CWD" >&2; exit 1; }
source "$CLAUDE_ENV_FILE"

# Host-env isolation (PRI-2494): env -i + explicit allowlist, matching the
# opencode/serf launchers. Host ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN /
# CLAUDE_CODE_* feature flags must not reconfigure the agent under test.
# env -i also supersedes the old -u CLAUDECODE / -u CLAUDE_CODE_SESSION_ID
# nested-session strips: nothing survives that is not listed here.
env_args=(
  "PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  "TERM=${TERM:-xterm-256color}"
  "LANG=${LANG:-C.UTF-8}"
)

exec env -i \
  "${env_args[@]}" \
  $QUORUM_HOME_ENV \
  CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude --dangerously-skip-permissions --plugin-dir "$SUPERPOWERS_ROOT" --model "$CLAUDE_MODEL" "$@"
```

- [ ] **Step 4: Run the test**

Run: `bun test test/launcher-env-isolation.test.ts`
Expected: PASS.

- [ ] **Step 5: Live smoke (nested-session persistence must survive env -i)**

The old `-u` strips existed for transcript persistence from inside a Claude Code session; `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` is the authoritative override and is on the allowlist, but this is the one behavior a unit test cannot prove. Run the smoke scenario live:

Run: `export SUPERPOWERS_ROOT=<superpowers checkout> && bun run quorum run scenarios/00-quorum-smoke-hello-world --coding-agent claude`
Expected: verdict `pass`, and `<runDir>/trajectory.json` non-empty (capture worked → persistence survived). This is a trusted-maintainer live eval: run locally, not CI.

- [ ] **Step 6: Commit**

```bash
git add coding-agents/claude-context/launch-agent test/launcher-env-isolation.test.ts
git commit -m "fix(claude): isolate the launcher env with env -i + allowlist

Host ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_* flags
inherited into the agent under test could silently reconfigure it per
operator machine. The launcher now builds its env from scratch like
opencode/serf: PATH/TERM/LANG, the throwaway-home fragment, the forced
session persistence flag, and the run's ANTHROPIC_API_KEY (PRI-2494)."
```

---

### Task 6: Codex launcher env isolation (env -i allowlist)

The codex launcher scrubs 4 `OPENAI_*` vars but inherits everything else (host `CODEX_*` overrides, proxy vars, unrelated provider keys). Same conversion. One wrinkle: the subscription path needs codex's auth from `$HOME/.codex/auth.json` — which the throwaway-home fragment already provides — and the api-key path sources `CODEX_PROVIDER_API_KEY` from `$CODEX_ENV_FILE`. Forward `CODEX_PROVIDER_API_KEY` only when set (conditional array append, the opencode pattern), so the subscription path's env stays minimal.

**Files:**
- Modify: `coding-agents/codex-context/launch-agent`
- Test: `test/launcher-env-isolation.test.ts` (extend)

**Interfaces:**
- Consumes: the Task 5 test helpers (`installLauncher`, `launchAndDump`, `HOSTILE`).
- Produces: behavior contract — codex child env is PATH/TERM/LANG + home fragment + (when the env file set it) `CODEX_PROVIDER_API_KEY`; all `OPENAI_*` and other host vars are gone.

- [ ] **Step 1: Write the failing tests**

Append to `test/launcher-env-isolation.test.ts`:

```typescript
test('codex launcher: hostile host env never reaches the agent', () => {
  const env = launchAndDump('codex');
  for (const key of Object.keys(HOSTILE)) {
    expect({ key, value: env[key] }).toEqual({ key, value: undefined });
  }
  // The api-key path's provider key DOES reach it (sourced from CODEX_ENV_FILE).
  expect(env['CODEX_PROVIDER_API_KEY']).toBe('sk-codex-test');
  expect(env['HOME']).not.toBe('/host/home');
});

test('codex launcher: subscription path (no env file) forwards no provider key', () => {
  const { launcher, binDir, envDump } = installLauncher('codex');
  // Simulate the subscription path: the substituted CODEX_ENV_FILE does not
  // exist. installLauncher wrote it; point the launcher at a missing one by
  // re-substituting is overkill — instead delete the file it sources.
  // The launcher's `[ -f "$CODEX_ENV_FILE" ] && .` guard makes this the
  // subscription path exactly.
  const proc = spawnSync('bash', [launcher], {
    encoding: 'utf8',
    env: { ...HOSTILE, PATH: `${binDir}:/usr/bin:/bin`, HOME: '/host/home' },
  });
  expect(proc.status).toBe(0);
  const env = parseEnvDump(envDump);
  expect(env['OPENAI_API_KEY']).toBe(undefined);
  expect(env['HOME']).not.toBe('/host/home');
});
```

For the subscription-path test, adjust `installLauncher` to take an option:

```typescript
function installLauncher(
  agent: 'claude' | 'codex',
  opts: { omitEnvFile?: boolean } = {},
): { launcher: string; binDir: string; envDump: string } {
```

and wrap the env-file write:

```typescript
  const envFile = join(runDir, `${agent}.env`);
  if (!opts.omitEnvFile) {
    writeFileSync(/* … as before … */);
  }
```

then the subscription test calls `installLauncher('codex', { omitEnvFile: true })`.

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/launcher-env-isolation.test.ts`
Expected: the two codex tests FAIL (`SOME_RANDOM_HOST_VAR` etc. survive).

- [ ] **Step 3: Rewrite the codex launcher**

Replace the `set -euo pipefail` block onward in `coding-agents/codex-context/launch-agent` (keep the header comments; replace the `-u` scrub paragraph with the env -i note; update the manual-command examples):

```bash
set -euo pipefail
cd "$QUORUM_AGENT_CWD" || { echo "launch-agent: cannot cd to $QUORUM_AGENT_CWD" >&2; exit 1; }

[ -f "$CODEX_ENV_FILE" ] && . "$CODEX_ENV_FILE"

# Host-env isolation (PRI-2494): env -i + explicit allowlist, matching the
# opencode/serf launchers. Supersedes the old targeted -u OPENAI_* scrubs:
# nothing survives that is not listed here. CODEX_PROVIDER_API_KEY is
# forwarded only when the api-key path's env file set it; the subscription
# path authenticates from $HOME/.codex/auth.json under the throwaway home.
env_args=(
  "PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  "TERM=${TERM:-xterm-256color}"
  "LANG=${LANG:-C.UTF-8}"
)
if [[ -n "${CODEX_PROVIDER_API_KEY-}" ]]; then
  env_args+=("CODEX_PROVIDER_API_KEY=$CODEX_PROVIDER_API_KEY")
fi

exec env -i \
  "${env_args[@]}" \
  $QUORUM_HOME_ENV \
  codex --dangerously-bypass-approvals-and-sandbox "$@"
```

- [ ] **Step 4: Run the launcher tests, then everything**

Run: `bun test test/launcher-env-isolation.test.ts && bun run check`
Expected: all PASS (claude + codex isolation tests, full suite, lint, typecheck).

- [ ] **Step 5: Live smoke**

Run: `bun run quorum run scenarios/00-quorum-smoke-hello-world --coding-agent codex`
Expected: verdict `pass` with a non-empty trajectory (codex auth path intact under env -i). Trusted-maintainer live eval: local only.

- [ ] **Step 6: Commit**

```bash
git add coding-agents/codex-context/launch-agent test/launcher-env-isolation.test.ts
git commit -m "fix(codex): isolate the launcher env with env -i + allowlist

The launcher scrubbed four OPENAI_* vars but inherited every other host
var (CODEX_* overrides, proxies, unrelated provider keys). It now
builds its env from scratch like opencode/serf; CODEX_PROVIDER_API_KEY
is forwarded only when the api-key env file set it (PRI-2494)."
```

---

### Task 7: Full verification + ticket close-out

- [ ] **Step 1: Full local verification**

Run: `bun run check && bun run quorum check`
Expected: both exit 0, output pristine.

- [ ] **Step 2: Acceptance sweep against PRI-2494's criteria**

Each criterion, verified live:
1. Typo'd verb any position → `bun run quorum check` on a scratch scenario containing `file-exsts` reports `unknown check verb`; a forced run composes indeterminate with `pre-checks crashed (exit 127): …command not found`.
2. `file-exists` with zero args → exit 127, record `broken` (Task 2 tests).
3. Fresh run's verdict.json names superpowers/harness revs + CLI versions (Task 5/6 smoke runs double as this check — inspect `verdict.json`).
4. `ANTHROPIC_BASE_URL=http://evil.example` exported → absent from claude child env (Task 5 test).
5. `OPENAI_BASE_URL` etc. exported → absent from codex child env (Task 6 test).

- [ ] **Step 3: Update CLAUDE.md's checks description**

`CLAUDE.md`'s `src/checks/` architecture bullet describes the record collection; append the crash-band phase discipline in one sentence: "A crash-band verb exit (126/127/signal) anywhere in a phase aborts the phase (ERR trap), so a broken check can never vanish from the verdict." Keep the edit minimal — one sentence in the existing bullet, no restructure.

- [ ] **Step 4: Commit docs, push, PR**

```bash
git add CLAUDE.md docs/superpowers/plans/2026-07-06-pri-2494-pre-campaign-hardening.md
git commit -m "docs: record the checks crash-band phase discipline (PRI-2494)"
git push -u origin drew/pri-2494-quorum-pre-campaign-hardening-close-check-dsl-false-pass
```

Then open the PR against main citing PRI-2494, move the ticket to In Review with the reflective comment (linear-ticket-lifecycle skill).

---

## Self-Review

**Spec coverage against PRI-2494:** phase-level crash masking → Task 1; static verb validation → Task 3; FS-verb arity gates → Task 2; trailing-`**` glob → Task 2; provenance (superpowers rev, agent CLI version, gauntlet rev, harness rev) → Task 4; claude env isolation → Task 5; codex env isolation → Task 6; acceptance criteria → Task 7 sweep. Out-of-scope list untouched. ✓

**Placeholder scan:** no TBDs; every code step carries the actual code; commands carry expected output. ✓

**Type consistency:** `RunPhaseResult.stderr` introduced in Task 1 and consumed by Task 1 Step 5 only; `TRANSCRIPT_VERBS` defined Task 3 Step 3, consumed Step 4; `collectProvenance` signature identical between Task 4 interface block, tests, and implementation; `installLauncher(agent, opts)` option added in Task 6 matches Task 5's original signature via a defaulted parameter. ✓

**Known risks, stated:** Task 3's token allowlist may need corpus-driven additions (Step 5 explicitly allows extending the allowlist, never weakening verb matching). Task 5's one unprovable-by-unit-test behavior (nested-session persistence) gets a mandatory live smoke. Task 1's trap relies on bash ERR semantics with `set -E` — validated empirically before this plan was written.
