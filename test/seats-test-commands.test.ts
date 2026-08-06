import { expect, test } from 'bun:test';
import {
  isEvidenceRead,
  matchSuiteRuns,
  normalizeCommand,
  stripCommitMessages,
  stripFullLineComments,
  stripHeredocBodies,
} from '../src/seats/test-commands.ts';

// Suite-command detection. Every string in this file is copied (and trimmed)
// from a recorded sdd-* run under results/ — the false positives asserted here
// are ones the scratchpad prototypes actually produced.

test('a heredoc body is stripped but the command after the terminator survives', () => {
  // Real Claude Bash call from sdd-go-fractals-* (Implement Task 5): a probe
  // test file is written via heredoc and THEN a focused go test is run. The
  // prototype's lazy `<<...[\s\S]*?$/m` stripped only to the first newline, so
  // the body stayed in; a strip-to-end-of-string would instead lose the real
  // `go test` that follows the terminator. Both must be avoided.
  const command = [
    "cat > /tmp/eyeball_test.go <<'EOF'",
    'package mandelbrot',
    'func TestEyeball(t *testing.T) {}',
    'EOF',
    'cp /tmp/eyeball_test.go internal/mandelbrot/eyeball_test.go',
    'go test ./internal/mandelbrot/... -run TestEyeball -v 2>&1',
  ].join('\n');
  const stripped = stripHeredocBodies(command);
  expect(stripped).not.toContain('package mandelbrot');
  expect(stripped).toContain(
    'go test ./internal/mandelbrot/... -run TestEyeball',
  );
  const matches = matchSuiteRuns(normalizeCommand(command));
  expect(matches.map((m) => m.family)).toEqual(['go-test']);
});

test('a git commit heredoc message mentioning npm test is NOT a suite run', () => {
  // Real Claude Bash call from sdd-svelte-todo-claude-20260612T001158Z-7dff.
  // The commit body says "14 tests green" and the subject mentions vitest; the
  // prototype counted this as a test-suite invocation.
  const command = [
    "git add package.json src/lib/store.ts && git commit -m \"$(cat <<'EOF'",
    'feat(store): add Todo store with TDD tests and vitest setup',
    '',
    'Installs vitest, wires up test script; npm test passes with 14 tests green.',
    'EOF',
    ')"',
  ].join('\n');
  expect(matchSuiteRuns(normalizeCommand(command))).toEqual([]);
});

test('a git commit -m single-quoted message mentioning a suite is NOT a suite run', () => {
  // Real Codex exec cmd from sdd-escalates-broken-plan-codex-*: -m without a
  // heredoc still has to be stripped.
  const command =
    "git commit -m 'chore: npm test and vitest green' && git check-ignore -v .worktrees";
  expect(stripCommitMessages(command)).not.toContain('npm test');
  expect(matchSuiteRuns(normalizeCommand(command))).toEqual([]);
});

test('-m is only stripped from a git commit segment, not from every command', () => {
  // Scoping guard: `-m` means something else to most commands, so stripping it
  // globally would silently delete real arguments.
  const command = 'mkdir -m 755 build && npm test';
  expect(stripCommitMessages(command)).toContain('-m 755');
  expect(
    matchSuiteRuns(normalizeCommand(command)).map((m) => m.family),
  ).toEqual(['npm-test']);
});

test('a full-line shell comment mentioning go test is NOT a suite run', () => {
  // Real Claude Bash call: a two-line comment reasoning about `go test`
  // semantics, with no command at all.
  const command = [
    '# Check if PATH matters for "go build" in TestMain',
    '# When invoked by `go test`, the test binary runs in the package dir',
    'go vet ./...',
  ].join('\n');
  expect(stripFullLineComments(command)).not.toContain('go test');
  expect(matchSuiteRuns(normalizeCommand(command))).toEqual([]);
});

test('installing a test runner is not running it', () => {
  // Real Claude Bash call from sdd-svelte-todo-*. The bare-word families
  // (vitest/jest/pytest) appear as package NAMES constantly; only a family
  // token that heads its own command segment counts.
  expect(
    matchSuiteRuns(normalizeCommand('npm install --save-dev vitest 2>&1')),
  ).toEqual([]);
  expect(
    matchSuiteRuns(
      normalizeCommand('npm install -D vitest @testing-library/jest-dom'),
    ),
  ).toEqual([]);
});

test('a config filename that starts with a family name is not a suite run', () => {
  // Real Claude Bash call: `git show 603af5f:vitest.config.ts` matched the
  // bare `vitest` family under a \b-only trailing boundary.
  expect(
    matchSuiteRuns(normalizeCommand('git show 603af5f:vitest.config.ts')),
  ).toEqual([]);
});

test('a suite name inside an rg pattern or a for-loop list is not a suite run', () => {
  // Real Codex exec cmds: the reviewer greps for test config, and the final
  // reviewer loops over README command strings to check they are documented.
  expect(
    matchSuiteRuns(normalizeCommand('rg -n "vitest|environment|setupFiles" .')),
  ).toEqual([]);
  expect(
    matchSuiteRuns(
      normalizeCommand(
        "for required in 'npm install' 'npm test' 'npx playwright test'; do rg -Fq \"$required\" README.md; done",
      ),
    ),
  ).toEqual([]);
});

test('a suite run still counts behind env assignments and npx/npm exec runners', () => {
  // Real Codex exec cmd: `npm exec --no -- playwright test`.
  expect(
    matchSuiteRuns(normalizeCommand('npm exec --no -- playwright test')).map(
      (m) => m.family,
    ),
  ).toEqual(['playwright-test']);
  expect(
    matchSuiteRuns(normalizeCommand('CI=1 npm test')).map((m) => m.family),
  ).toEqual(['npm-test']);
  expect(
    matchSuiteRuns(normalizeCommand('npx playwright test')).map(
      (m) => m.family,
    ),
  ).toEqual(['playwright-test']);
});

test('a chained shell line yields one match per suite family it runs', () => {
  // Real Codex exec cmd from sdd-svelte-todo-codex-*: the echo banner must not
  // add a match, and both families in the chain must be reported.
  const command =
    'echo "=== npm test ===" && npm test && npm run build && npx playwright test';
  expect(
    matchSuiteRuns(normalizeCommand(command)).map((m) => m.family),
  ).toEqual(['npm-test', 'playwright-test']);
});

test('npm test and npm run test are the same suite family', () => {
  expect(matchSuiteRuns('npm run test')[0]?.family).toBe('npm-test');
  expect(matchSuiteRuns('npm test')[0]?.family).toBe('npm-test');
});

test('scope: a bare or package-wide invocation is full', () => {
  expect(matchSuiteRuns('npm test')[0]?.scope).toBe('full');
  expect(matchSuiteRuns('pytest')[0]?.scope).toBe('full');
  expect(matchSuiteRuns('pytest -q')[0]?.scope).toBe('full');
  expect(matchSuiteRuns('go test ./...')[0]?.scope).toBe('full');
  expect(matchSuiteRuns('go test ./internal/mandelbrot/...')[0]?.scope).toBe(
    'full',
  );
  expect(matchSuiteRuns('make test')[0]?.scope).toBe('full');
  expect(matchSuiteRuns('node --test')[0]?.scope).toBe('full');
  expect(matchSuiteRuns('vitest run')[0]?.scope).toBe('full');
  expect(matchSuiteRuns('npm test -- --coverage')[0]?.scope).toBe('full');
});

test('scope: a test-name filter or a single test file is focused', () => {
  // These are the shapes the reviewer prompt permits ("a focused test, never a
  // package-wide suite"), all copied from recorded runs.
  expect(
    matchSuiteRuns(
      'go test ./internal/mandelbrot/ -run TestGenerateSingleChar -v',
    )[0]?.scope,
  ).toBe('focused');
  expect(
    matchSuiteRuns('npm test -- src/lib/TodoInput.test.ts')[0]?.scope,
  ).toBe('focused');
  expect(matchSuiteRuns('node --test test/report.test.js')[0]?.scope).toBe(
    'focused',
  );
  expect(
    matchSuiteRuns('pytest tests/test_report.py::test_banner')[0]?.scope,
  ).toBe('focused');
  expect(matchSuiteRuns('npm test -- -t "adds a todo"')[0]?.scope).toBe(
    'focused',
  );
  expect(matchSuiteRuns('cargo test formats_banner')[0]?.scope).toBe('focused');
});

test('scope: go test -timeout is not mistaken for the -t name filter', () => {
  expect(matchSuiteRuns('go test -timeout 30s ./...')[0]?.scope).toBe('full');
});

test('evidence reads are the read-only inspections of report/brief/log paths', () => {
  // Real reviewer-seat commands. These are the intended "re-read the report"
  // behavior and must be counted separately from suite runs.
  expect(
    isEvidenceRead(
      'grep -n -A 25 -i "task 2" .superpowers/sdd/plan/task-2-report.md',
    ),
  ).toBe(true);
  expect(isEvidenceRead('cat .git/sdd/task-5-brief.md')).toBe(true);
  expect(
    isEvidenceRead("sed -n '1,80p' .superpowers/sdd/plan/task-1-report.md"),
  ).toBe(true);
  expect(isEvidenceRead('rg -n "RED" build.log | head -20')).toBe(true);
  // Not an evidence read: not a reader, or not a report/brief/log path.
  expect(isEvidenceRead('npm test')).toBe(false);
  expect(isEvidenceRead('cat src/report.js')).toBe(false);
  expect(isEvidenceRead('rm -f .superpowers/sdd/plan/task-1-report.md')).toBe(
    false,
  );
});
