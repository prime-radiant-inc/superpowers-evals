// Characterization tests for check-record emission: they empirically pin WHAT
// the runtime dispatcher (prelude verbs -> src/cli/check-tool.ts /
// src/cli/check-transcript.ts -> src/check/record.ts) records for each
// checks.sh construct, driving the real `runPhase` (src/checks/index.ts).
//
// These pin the rules the check-manifest extractor (Task 2) must mirror:
//   - a plain fs verb records under the verb name with its literal args;
//   - `not <fs-verb> ...` records under the INNER verb name with negated=true;
//   - a plain `check-transcript <verb> ...` records under the inner VERB name
//     (args = the verb's own args, wrapper stripped);
//   - `not check-transcript <verb> ...` records under the WRAPPER name
//     `check-transcript` with negated=true and args = [verb, ...verb-args].
//
// Every case pins the full {check, args, negated, passed} tuple — the
// extractor's rules are built on these values.
//
// If reality and these expectations ever disagree, REALITY WINS: change the
// expectations, then fix the extractor — never the other way around.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareRecords,
  extractManifest,
  ManifestExtractionError,
  manifestPath,
  readManifest,
  writeManifest,
} from '../src/check/manifest.ts';
import { runPhase } from '../src/checks/index.ts';
import type { CheckManifest } from '../src/contracts/check-manifest.ts';

const REPO_ROOT = join(import.meta.dir, '..');

interface PhaseBody {
  pre: string;
  post: string;
}

async function phaseRecords(
  body: PhaseBody,
  opts: { transcriptPath?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-char-'));
  const checksSh = join(dir, 'checks.sh');
  writeFileSync(
    checksSh,
    `pre() {\n${body.pre}\n}\n\npost() {\n${body.post}\n}\n`,
  );
  const workdir = mkdtempSync(join(tmpdir(), 'manifest-wd-'));
  writeFileSync(join(workdir, 'present.txt'), 'x');
  const pre = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    repoRoot: REPO_ROOT,
    ...opts,
  });
  const post = await runPhase({
    checksSh,
    phase: 'post',
    workdir,
    repoRoot: REPO_ROOT,
    ...opts,
  });
  return { pre: pre.records, post: post.records };
}

// A committed minimal ATIF trajectory with one Write tool call — the smallest
// fixture the transcript checks can match against (validates against
// src/atif/validate.ts). check-transcript reads steps' tool_calls keyed by
// function_name (src/atif/project.ts flattenToolCalls); check-transcript.test.ts
// builds these inline, so the shared minimal one lives here as a committed file.
const TRAJECTORY_FIXTURE = join(
  REPO_ROOT,
  'test/fixtures/atif-minimal-write-trajectory.json',
);

describe('record-emission characterization (pins extractor rules)', () => {
  test('plain fs verb records under the verb name with literal args', async () => {
    const { post } = await phaseRecords({
      pre: '    file-exists present.txt',
      post: '    file-exists present.txt',
    });
    expect(post).toHaveLength(1);
    expect(post[0]).toMatchObject({
      check: 'file-exists',
      args: ['present.txt'],
      negated: false,
      passed: true,
      phase: 'post',
    });
  });

  test('`not <fs-verb>` records under the verb name with negated=true', async () => {
    const { post } = await phaseRecords({
      pre: '    file-exists present.txt',
      post: '    not file-exists absent.txt',
    });
    expect(post).toHaveLength(1);
    expect(post[0]).toMatchObject({
      check: 'file-exists',
      args: ['absent.txt'],
      negated: true,
      passed: true,
    });
  });

  test('single-quoted $ args are NOT expanded (literal in the record)', async () => {
    const { post } = await phaseRecords({
      pre: '    file-exists present.txt',
      post: `    command-succeeds 'test -n "$PWD"'`,
    });
    expect(post).toHaveLength(1);
    expect(post[0]).toMatchObject({
      check: 'command-succeeds',
      args: ['test -n "$PWD"'],
      negated: false,
      passed: true,
    });
  });

  test('plain transcript check records under the inner VERB name', async () => {
    const { post } = await phaseRecords(
      {
        pre: '    file-exists present.txt',
        post: '    check-transcript tool-called Write',
      },
      { transcriptPath: TRAJECTORY_FIXTURE },
    );
    expect(post).toHaveLength(1);
    expect(post[0]).toMatchObject({
      check: 'tool-called',
      args: ['Write'],
      negated: false,
      passed: true,
    });
  });

  test('negated transcript check records under the WRAPPER name check-transcript', async () => {
    const { post } = await phaseRecords(
      {
        pre: '    file-exists present.txt',
        post: '    not check-transcript tool-called Bash',
      },
      { transcriptPath: TRAJECTORY_FIXTURE },
    );
    expect(post).toHaveLength(1);
    // The inner verb rides as args[0]: args = [verb, ...verb-args], NOT the
    // verb's own args. Load-bearing pin for the extractor's RECORD_NAME_RULES
    // (Task 2).
    expect(post[0]).toMatchObject({
      check: 'check-transcript',
      args: ['tool-called', 'Bash'],
      negated: true,
      passed: true,
    });
  });
});

// --- Static extractor + multiset compare (Task 2) ---
// The extractor must agree with the record-emission rules pinned above.

function writeChecksSh(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-ex-'));
  const p = join(dir, 'checks.sh');
  writeFileSync(p, content);
  return p;
}

describe('extractManifest', () => {
  test('extracts plain verbs with args, phases, and multiplicity', () => {
    const p = writeChecksSh(
      'pre() {\n    git-repo\n}\n\npost() {\n    file-exists a.txt\n    file-exists a.txt\n    file-contains a.txt hello\n}\n',
    );
    const m = extractManifest(p);
    expect(m.entries).toEqual([
      {
        phase: 'pre',
        check: 'git-repo',
        args: [],
        negated: false,
        count: 1,
      },
      {
        phase: 'post',
        check: 'file-exists',
        args: ['a.txt'],
        negated: false,
        count: 2,
      },
      {
        phase: 'post',
        check: 'file-contains',
        args: ['a.txt', 'hello'],
        negated: false,
        count: 1,
      },
    ]);
  });

  test('encodes `not` and transcript naming per the Task 1 characterization', () => {
    const p = writeChecksSh(
      'pre() {\n    git-repo\n}\n\npost() {\n    not file-exists gone.txt\n    check-transcript skill-called superpowers:brainstorming\n    not check-transcript tool-called Bash\n}\n',
    );
    const m = extractManifest(p);
    expect(m.entries).toEqual([
      {
        phase: 'pre',
        check: 'git-repo',
        args: [],
        negated: false,
        count: 1,
      },
      {
        phase: 'post',
        check: 'file-exists',
        args: ['gone.txt'],
        negated: true,
        count: 1,
      },
      {
        phase: 'post',
        check: 'skill-called',
        args: ['superpowers:brainstorming'],
        negated: false,
        count: 1,
      },
      // Wrapper-name rule from Task 1 characterization:
      {
        phase: 'post',
        check: 'check-transcript',
        args: ['tool-called', 'Bash'],
        negated: true,
        count: 1,
      },
    ]);
  });

  test('any token containing $ makes args a wildcard (null)', () => {
    const p = writeChecksSh(
      `pre() {\n    git-repo\n}\n\npost() {\n    command-succeeds 'test -n "$PWD"'\n}\n`,
    );
    const m = extractManifest(p);
    expect(m.entries).toEqual([
      {
        phase: 'pre',
        check: 'git-repo',
        args: [],
        negated: false,
        count: 1,
      },
      {
        phase: 'post',
        check: 'command-succeeds',
        args: null,
        negated: false,
        count: 1,
      },
    ]);
  });

  test('unknown verb throws ManifestExtractionError', () => {
    const p = writeChecksSh(
      'pre() {\n    file-exsts a.txt\n}\n\npost() {\n    git-repo\n}\n',
    );
    expect(() => extractManifest(p)).toThrow(ManifestExtractionError);
  });

  test('setup-helpers lines are rejected (never valid in checks.sh)', () => {
    const p = writeChecksSh(
      'pre() {\n    setup-helpers run init_repo\n}\n\npost() {\n    git-repo\n}\n',
    );
    expect(() => extractManifest(p)).toThrow(ManifestExtractionError);
  });

  // --- corpus acceptance: constructs real scenarios/*/checks.sh files use ---

  test('double-quoted backslash is retained before non-special chars (corpus: cost-trivial-task-review-fanout)', () => {
    // Bash keeps \\ inside double quotes except before $ ` " \\ — so this
    // scenario's arg must extract with every backslash intact, exactly as
    // bash passes it to check-tool at runtime.
    const p = writeChecksSh(
      `pre() {\n    git-repo\n}\n\npost() {\n    file-contains 'src/app.js' "console\\.log\\('app started'\\)"\n}\n`,
    );
    const m = extractManifest(p);
    expect(m.entries).toEqual([
      {
        phase: 'pre',
        check: 'git-repo',
        args: [],
        negated: false,
        count: 1,
      },
      {
        phase: 'post',
        check: 'file-contains',
        args: ['src/app.js', "console\\.log\\('app started'\\)"],
        negated: false,
        count: 1,
      },
    ]);
  });

  test('mid-word # stays literal (bash: # only starts a comment at word start)', () => {
    const p = writeChecksSh(
      'pre() {\n    git-repo\n}\n\npost() {\n    file-contains a.txt x#y\n}\n',
    );
    expect(extractManifest(p).entries).toEqual([
      {
        phase: 'pre',
        check: 'git-repo',
        args: [],
        negated: false,
        count: 1,
      },
      {
        phase: 'post',
        check: 'file-contains',
        args: ['a.txt', 'x#y'],
        negated: false,
        count: 1,
      },
    ]);
  });

  test('the bare bash no-op `:` placeholder emits no entry (corpus: pure-AC scenarios)', () => {
    const p = writeChecksSh(
      'pre() {\n    git-repo\n    git-branch main\n}\n\npost() {\n    :\n}\n',
    );
    // `:` is a bash builtin, not a check verb: it records nothing at runtime,
    // so the manifest carries only the pre entries — zero post entries.
    expect(extractManifest(p).entries).toEqual([
      {
        phase: 'pre',
        check: 'git-repo',
        args: [],
        negated: false,
        count: 1,
      },
      {
        phase: 'pre',
        check: 'git-branch',
        args: ['main'],
        negated: false,
        count: 1,
      },
    ]);
  });

  // --- rejection: unmodelable constructs (none appear in the 85-file corpus) ---

  test('inline comments are rejected, not silently eaten into args', () => {
    const p = writeChecksSh(
      'pre() {\n    git-repo\n}\n\npost() {\n    file-exists a.txt # trailing note\n}\n',
    );
    expect(() => extractManifest(p)).toThrow(ManifestExtractionError);
  });

  test.each([
    ';',
    '&&',
    '||',
    '|',
    '>',
    '`',
    '(',
  ])('unquoted control operator %p is rejected', (op) => {
    const body =
      op === ';'
        ? 'file-exists a.txt; file-contains a.txt x'
        : `git-clean ${op} git-repo`;
    const p = writeChecksSh(
      `pre() {\n    git-repo\n}\n\npost() {\n    ${body}\n}\n`,
    );
    expect(() => extractManifest(p)).toThrow(ManifestExtractionError);
  });

  test('one-line function bodies are rejected, not silently skipped', () => {
    const p = writeChecksSh(
      'pre() {\n    git-repo\n}\n\npost() { file-exists a.txt; }\n',
    );
    expect(() => extractManifest(p)).toThrow(ManifestExtractionError);
  });

  // --- rejection: function-structure defects (census: 0 in the 85-file
  // corpus; every real checks.sh is exactly `pre() { … }\n\npost() { … }` with
  // no top-level code) ---

  test('EOF inside a function body (missing closing brace) is rejected', () => {
    const p = writeChecksSh(
      'pre() {\n    git-repo\n}\n\npost() {\n    git-repo\n',
    );
    expect(() => extractManifest(p)).toThrow(ManifestExtractionError);
  });

  test("stray '}' with no matching declaration is rejected", () => {
    const p = writeChecksSh(
      'pre() {\n    git-repo\n}\n}\n\npost() {\n    git-repo\n}\n',
    );
    expect(() => extractManifest(p)).toThrow(ManifestExtractionError);
  });

  test("stray '{' outside a function declaration is rejected", () => {
    const p = writeChecksSh(
      'pre() {\n    git-repo\n}\n\n{\n    git-repo\n}\n\npost() {\n    git-repo\n}\n',
    );
    expect(() => extractManifest(p)).toThrow(ManifestExtractionError);
  });

  test('a phase declaration nested inside another function body is rejected', () => {
    const p = writeChecksSh(
      'pre() {\n    git-repo\n}\n\npost() {\n    not file-exists x\n    pre() {\n        git-repo\n    }\n}\n',
    );
    expect(() => extractManifest(p)).toThrow(ManifestExtractionError);
  });

  test("a declaration line with no opening '{' is rejected", () => {
    const p = writeChecksSh(
      'pre() {\n    git-repo\n}\n\npost()\n{\n    git-repo\n}\n',
    );
    expect(() => extractManifest(p)).toThrow(ManifestExtractionError);
  });

  test('redeclaration of the same phase is rejected', () => {
    const p = writeChecksSh(
      'pre() {\n    git-repo\n}\n\npre() {\n    git-branch main\n}\n\npost() {\n    git-repo\n}\n',
    );
    expect(() => extractManifest(p)).toThrow(ManifestExtractionError);
  });

  test('top-level code outside any function body is rejected', () => {
    const p = writeChecksSh(
      'set -euo pipefail\n\npre() {\n    git-repo\n}\n\npost() {\n    git-repo\n}\n',
    );
    expect(() => extractManifest(p)).toThrow(ManifestExtractionError);
  });

  test('an unquoted trailing backslash (line continuation) is rejected', () => {
    const p = writeChecksSh(
      'pre() {\n    git-repo\n}\n\npost() {\n    file-contains a.txt b\\\n}\n',
    );
    expect(() => extractManifest(p)).toThrow(ManifestExtractionError);
  });
});

describe('writeManifest', () => {
  test('serializes canonical key order + trailing newline regardless of caller insertion order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manifest-wm-'));
    // Same value as the expected bytes below, but every object's keys are in
    // scrambled insertion order — writeManifest must project them canonically.
    const scrambled: CheckManifest = {
      entries: [
        {
          count: 2,
          negated: false,
          args: ['a.txt'],
          check: 'file-exists',
          phase: 'post',
        },
      ],
      schema_version: 1,
    };
    writeManifest(dir, scrambled);
    const expected = `{\n  "schema_version": 1,\n  "entries": [\n    {\n      "phase": "post",\n      "check": "file-exists",\n      "args": [\n        "a.txt"\n      ],\n      "negated": false,\n      "count": 2\n    }\n  ]\n}\n`;
    const bytes = readFileSync(manifestPath(dir), 'utf8');
    expect(bytes).toEqual(expected);
    expect(bytes.endsWith('\n')).toBe(true);
    // Round-trip: the bytes parse back to the same manifest value.
    expect(readManifest(dir)).toEqual(scrambled);
  });
});

describe('compareRecords', () => {
  const rec = (
    over: Partial<import('../src/contracts/verdict.ts').CheckRecord>,
  ) => ({
    check: 'file-exists',
    args: ['a.txt'],
    negated: false,
    passed: true,
    detail: null,
    phase: 'post' as const,
    ...over,
  });
  const manifest = (
    entries: import('../src/contracts/check-manifest.ts').ManifestEntry[],
  ) => ({ schema_version: 1 as const, entries });

  test('exact multiset match → empty diffs', () => {
    const m = manifest([
      {
        phase: 'post',
        check: 'file-exists',
        args: ['a.txt'],
        negated: false,
        count: 2,
      },
    ]);
    const d = compareRecords(m, [rec({}), rec({})]);
    expect(d).toEqual({ missing: [], unexpected: [] });
  });

  test('vanished record → missing; extra record → unexpected', () => {
    const m = manifest([
      {
        phase: 'post',
        check: 'file-exists',
        args: ['a.txt'],
        negated: false,
        count: 2,
      },
    ]);
    expect(compareRecords(m, [rec({})]).missing).toHaveLength(1);
    expect(
      compareRecords(m, [
        rec({}),
        rec({}),
        rec({ check: 'git-repo', args: [] }),
      ]).unexpected,
    ).toHaveLength(1);
  });

  test('wildcard entry matches any args but still counts multiplicity', () => {
    const m = manifest([
      {
        phase: 'post',
        check: 'command-succeeds',
        args: null,
        negated: false,
        count: 1,
      },
    ]);
    expect(
      compareRecords(m, [
        rec({ check: 'command-succeeds', args: ['whatever expanded'] }),
      ]),
    ).toEqual({ missing: [], unexpected: [] });
    expect(compareRecords(m, []).missing).toHaveLength(1);
  });

  test('a FAILED record still satisfies its manifest entry (pass/fail is the composer verdict axis, presence is the manifest axis)', () => {
    const m = manifest([
      {
        phase: 'post',
        check: 'file-exists',
        args: ['a.txt'],
        negated: false,
        count: 1,
      },
    ]);
    expect(compareRecords(m, [rec({ passed: false })])).toEqual({
      missing: [],
      unexpected: [],
    });
  });
});
