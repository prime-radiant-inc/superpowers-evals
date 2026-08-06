// Suite-command detection for seat scoring.
//
// The question this module answers is narrow: did THIS shell command run a
// test suite, and was it the whole suite or a focused subset? The reviewer
// prompt in subagent-driven-development permits "a focused test, never a
// package-wide suite", so the full/focused split is load-bearing evidence, not
// decoration.
//
// Everything here operates on a shell command string. Getting that string out
// of a recorded log is the parsers' job (src/seats/parse-codex.ts in
// particular has to dig it out of a JS snippet).

/** The suite families we recognize. `npm test` and `npm run test` are the same
 *  family — they invoke the same package script — so they collapse to
 *  `npm-test`. `node --test` and `node test.js` stay separate: one is the Node
 *  test runner over a default glob, the other is a hand-rolled entry point. */
export type SuiteFamily =
  | 'pytest'
  | 'npm-test'
  | 'yarn-test'
  | 'pnpm-test'
  | 'bun-test'
  | 'node-test'
  | 'node-test-script'
  | 'go-test'
  | 'vitest'
  | 'jest'
  | 'playwright-test'
  | 'cargo-test'
  | 'make-test';

/** `full` = the whole package/module suite. `focused` = narrowed to specific
 *  tests by a name filter or a single test file. See classifyScope. */
export type SuiteScope = 'full' | 'focused';

export interface SuiteMatch {
  readonly family: SuiteFamily;
  readonly scope: SuiteScope;
  /** The command segment the family token headed, for eyeballing output. */
  readonly invocation: string;
}

// Source form of each family, as a regex fragment. Order matters only for
// readability; each is tried against the head of a command segment.
const FAMILY_PATTERNS: readonly (readonly [SuiteFamily, string])[] = [
  ['npm-test', 'npm\\s+(?:run\\s+)?test'],
  ['yarn-test', 'yarn\\s+test'],
  ['pnpm-test', 'pnpm\\s+test'],
  ['bun-test', 'bun\\s+test'],
  ['node-test', 'node\\s+--test'],
  ['node-test-script', 'node\\s+test\\.js'],
  ['go-test', 'go\\s+test'],
  ['playwright-test', 'playwright\\s+test'],
  ['cargo-test', 'cargo\\s+test'],
  ['make-test', 'make\\s+test'],
  ['pytest', 'pytest'],
  ['vitest', 'vitest'],
  ['jest', 'jest'],
];

// Words that may sit between the start of a command segment and the suite
// invocation without changing the fact that the suite is being RUN: env
// assignments, wrappers, package-manager exec shims, and shell keywords that
// open a compound command.
//
// This "must head its own segment" rule is what separates running a suite from
// merely naming one. `npm install -D vitest`, `rg -n "vitest|environment"`, and
// `for required in 'npm test'; do ...` all contain a family token but none of
// them runs a suite, and all three appear in the recorded corpus.
const RUNNER_PREFIX =
  '(?:' +
  '\\w+=\\S*\\s+' + // FOO=bar
  '|sudo\\s+|time\\s+|timeout\\s+\\S+\\s+' +
  '|npx\\s+(?:-{1,2}\\S+\\s+)*' +
  '|bunx\\s+|bun\\s+x\\s+' +
  '|npm\\s+exec\\s+(?:-{1,2}\\S+\\s+)*(?:--\\s+)?' +
  '|pnpm\\s+(?:exec|dlx)\\s+|yarn\\s+(?:exec|dlx)\\s+' +
  '|uv\\s+run\\s+|poetry\\s+run\\s+|pipenv\\s+run\\s+' +
  '|(?:[\\w.@+-]+/)*python[0-9]?(?:\\.[0-9]+)?\\s+-m\\s+' +
  '|do\\s+|then\\s+|else\\s+|\\{\\s*|\\(\\s*' +
  ')*';

// Trailing boundary. `\b` alone is not enough: it let `vitest.config.ts`,
// `jest-dom`, and `pytest==8.0` match their bare-word families. A family token
// must be followed by end-of-segment or a real separator, never by a name
// character, dot, slash, dash, or `=`.
const FAMILY_TAIL = '(?![\\w./=-])';

// A runner may be invoked by path: `.venv/bin/python -m pytest`,
// `./node_modules/.bin/vitest run`. The trailing `/` is required, so a wrapper
// script named `run-jest` does not read as jest.
const FAMILY_PATH_PREFIX = '(?:[\\w.@+-]+/)*';

const FAMILY_HEAD_REGEXES: readonly (readonly [SuiteFamily, RegExp])[] =
  FAMILY_PATTERNS.map(
    ([family, pattern]) =>
      [
        family,
        new RegExp(
          `^${RUNNER_PREFIX}${FAMILY_PATH_PREFIX}(?:${pattern})${FAMILY_TAIL}`,
        ),
      ] as const,
  );

// Shell operators that end one command and begin another. Newlines count.
const SEGMENT_SPLIT = /;|&&|\|\||\||\n/;

/**
 * Remove heredoc bodies: `<<WORD`, `<<'WORD'`, `<<"WORD"`, `<<-WORD`.
 *
 * A heredoc body is data, not commands, so a commit message or a generated
 * report that merely mentions `npm test` must not read as a suite run. The
 * body runs from the redirection to the terminator line; everything AFTER the
 * terminator is live command text again and MUST survive — recorded runs write
 * a probe test file via heredoc and then run a focused test on the next line.
 */
export function stripHeredocBodies(command: string): string {
  const open = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/;
  let rest = command;
  const kept: string[] = [];
  for (;;) {
    const start = open.exec(rest);
    if (start === null) {
      kept.push(rest);
      break;
    }
    const delimiter = start[3];
    if (delimiter === undefined) {
      kept.push(rest);
      break;
    }
    kept.push(rest.slice(0, start.index), ' ');
    const body = rest.slice(start.index + start[0].length);
    // The terminator is the delimiter alone on a line. `<<-` allows leading
    // tabs; allowing leading whitespace unconditionally is harmless here.
    const close = new RegExp(`^[ \\t]*${delimiter}[ \\t]*$`, 'm').exec(body);
    if (close === null) {
      // Unterminated heredoc: the rest of the command is all body.
      break;
    }
    rest = body.slice(close.index + close[0].length);
  }
  return kept.join('');
}

/**
 * Remove `-m` / `--message` values from `git commit` segments.
 *
 * Scoped to git commit on purpose: `-m` means a file mode to mkdir and a
 * memory limit to other tools, so stripping it everywhere would delete real
 * arguments. Run this AFTER stripHeredocBodies so that
 * `-m "$(cat <<'EOF' … EOF)"` is already reduced to `-m "$(cat  )"`.
 */
export function stripCommitMessages(command: string): string {
  const messageArg =
    /(--message|-m)(\s*=\s*|\s+)("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g;
  return command
    .split(/(;|&&|\|\||\||\n)/)
    .map((part) =>
      part.includes('git commit') ? part.replace(messageArg, ' ') : part,
    )
    .join('');
}

/** Blank out whole-line `#` comments. Only full-line comments are removed, so
 *  a `#` inside a quoted argument is left alone. */
export function stripFullLineComments(command: string): string {
  return command
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');
}

/** The three strips, in the order they have to run. */
export function normalizeCommand(command: string): string {
  return stripFullLineComments(
    stripCommitMessages(stripHeredocBodies(command)),
  );
}

// Flags that narrow a run to named tests, across the runners we see.
const NAME_FILTER_FLAGS =
  /(^|\s)(-run|-k|-t|-g|--grep|--filter|--testNamePattern|--test-name-pattern|--testPathPattern|--test-name)(=|\s|$)/;

// A positional argument that identifies specific tests rather than a package.
const TEST_FILE_ARG = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|svelte)$/;

/**
 * full vs focused.
 *
 * focused means the invocation names specific tests: a name-filter flag
 * (`-run`, `-k`, `-t`, `--grep`, …), a `file::test` selector, a single test
 * FILE, or — for `cargo test` only, whose positional argument IS a test-name
 * filter — a bare word.
 *
 * Everything else is full, including package and directory arguments
 * (`go test ./...`, `go test ./internal/mandelbrot/...`, `pytest tests/`).
 * That is deliberate: the reviewer prompt's prohibition is on running a
 * "package-wide suite", and a package or directory argument is exactly that.
 */
function classifyScope(family: SuiteFamily, args: string): SuiteScope {
  if (NAME_FILTER_FLAGS.test(args)) {
    return 'focused';
  }
  const positionals = args
    .split(/\s+/)
    .filter(
      (token) => token.length > 0 && token !== '--' && !token.startsWith('-'),
    );
  for (const token of positionals) {
    if (token.includes('::') || TEST_FILE_ARG.test(token)) {
      return 'focused';
    }
    if (family === 'cargo-test' && !token.includes('/')) {
      return 'focused';
    }
  }
  return 'full';
}

/**
 * Every suite invocation in `command`, in order.
 *
 * Pass the command through normalizeCommand first. One shell line can run
 * several families (`npm test && npx playwright test`), and each family is
 * reported at most once per line — repeating the same family inside one line
 * is not evidence of two independent decisions to run it.
 */
export function matchSuiteRuns(command: string): SuiteMatch[] {
  const out: SuiteMatch[] = [];
  const seen = new Set<SuiteFamily>();
  for (const rawSegment of command.split(SEGMENT_SPLIT)) {
    const segment = rawSegment.trim();
    if (segment.length === 0) {
      continue;
    }
    for (const [family, regex] of FAMILY_HEAD_REGEXES) {
      const head = regex.exec(segment);
      if (head === null || seen.has(family)) {
        continue;
      }
      seen.add(family);
      out.push({
        family,
        scope: classifyScope(family, segment.slice(head[0].length)),
        invocation: segment,
      });
      break;
    }
  }
  return out;
}

// Read-only readers. `sed -n` is the paging form; a bare `sed` is an editor.
const READER_HEAD = /^(rg|grep|egrep|cat|head|tail|nl|sed\s+-n)(\s|$)/;

// An evidence path is an SDD bookkeeping artifact or a log — NOT source code
// that happens to be named report.js.
const EVIDENCE_PATH =
  /(\.superpowers\/sdd\/|\.git\/sdd\/|[^\s'"]*\.log\b|[^\s'"]*(report|brief|plan|ledger|progress|review)[^\s'"]*\.(md|txt))/i;

/**
 * True when the command is a read-only inspection of report/brief/log
 * evidence. This is the behavior the reviewer prompt asks for — re-read the
 * implementer's report — and we count it separately so a reviewer seat that
 * did the right thing is distinguishable from one that ran nothing at all.
 */
export function isEvidenceRead(command: string): boolean {
  for (const rawSegment of normalizeCommand(command).split(SEGMENT_SPLIT)) {
    const segment = rawSegment.trim();
    if (READER_HEAD.test(segment) && EVIDENCE_PATH.test(segment)) {
      return true;
    }
  }
  return false;
}

/**
 * True when a bare path is SDD bookkeeping evidence — a report, brief, plan,
 * ledger, progress note, or log.
 *
 * Needed separately from isEvidenceRead because the two dialects re-read
 * evidence differently: Codex shells out (`sed -n '1,120p' …task-1-report.md`)
 * while Claude uses the native Read tool. Measuring only the shell form would
 * make Claude reviewers look like they never opened the report.
 */
export function isEvidencePath(path: string): boolean {
  return EVIDENCE_PATH.test(path);
}
