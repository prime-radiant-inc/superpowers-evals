// Registry backing the planted-negative coverage gates in
// test/check-tool.test.ts (fs verbs) and test/check-transcript.test.ts
// (transcript verbs).
//
// Insurance against a check verb wired to the wrong boolean: such a verb
// manufactures false GREENs that no expected-check manifest can catch. Every
// verb must therefore be proven able to FAIL (passed === false, negated ===
// false, not broken) against its target defect.
//
// Registration rules:
// - A verb belongs in NEGATIVE_COVERED only if a committed test asserts its
//   FAILING outcome against a real defect fixture (not a crash/broken record,
//   not a `not`-wrapped inversion). Each entry's comment names where.
// - NEGATIVE_EXEMPT is only for verbs that structurally cannot return
//   passed:false (documented always-pass stubs). Every exemption must cite its
//   design note; the gate enforces a non-empty reason so exemptions stay loud.
// - Both lists are checked for staleness by the gates: a registered verb that
//   no longer exists in its vocabulary fails the gate.

export const NEGATIVE_COVERED: {
  readonly fs: readonly string[];
  readonly transcript: readonly string[];
} = {
  // Each entry names where its committed failing case lives. The fs negative
  // tests live in test/check-tool.test.ts unless noted otherwise; the
  // per-harness bootstrap negatives live in test/fs-verbs-bootstrap.test.ts.
  fs: [
    // 'baseline-manifest (planted negative): drifted worktree fails, not broken'
    'baseline-manifest',
    // 'file-exists: literal path miss'
    'file-exists',
    // 'file-contains: pattern miss'
    'file-contains',
    // 'command-succeeds: non-zero fails with truncated, newline-stripped detail'
    'command-succeeds',
    // 'git-repo: pass inside a work tree, fail outside'
    'git-repo',
    // "git-branch: matches current; reports mismatch"
    'git-branch',
    // 'git-clean: clean tree passes, dirty fails'
    'git-clean',
    // 'git-count: all six operators against a 2-commit repo' (eq/ne/gt/gte/lt/lte fail legs)
    'git-count',
    // 'assert-checkout-clean: real drift fails'
    'assert-checkout-clean',
    // 'requires-tool: missing tool fails (env-missing, not broken)'
    'requires-tool',
    // 'files-exist: missing rels listed in detail'
    'files-exist',
    // fs-verbs-bootstrap.test.ts 'antigravity-plugin-installed fails when a plugin file is missing'
    'antigravity-plugin-installed',
    // fs-verbs-bootstrap.test.ts 'copilot-plugin-installed fails when a plugin file is missing'
    'copilot-plugin-installed',
    // fs-verbs-bootstrap.test.ts 'opencode-plugin-installed fails when the using-superpowers skill is missing'
    'opencode-plugin-installed',
    // fs-verbs-bootstrap.test.ts 'gemini-extension-linked fails when a metadata file is missing'
    'gemini-extension-linked',
    // fs-verbs-bootstrap.test.ts 'hermes-plugin-staged fails when a plugin file is missing'
    'hermes-plugin-staged',
    // fs-verbs-bootstrap.test.ts 'kimi-plugin-installed fails when installed.json is missing' (+content-validation legs)
    'kimi-plugin-installed',
    // 'codex-native-hook-configured: fail when plugin not enabled' (+ hooks/skills legs, both files)
    'codex-native-hook-configured',
    // fs-verbs-bootstrap.test.ts 'bootstrap-installed fails for an unrecognized agent' / '... env unset'
    'bootstrap-installed',
  ],
  // Transcript negative tests live in test/check-transcript.test.ts.
  transcript: [
    // 'tool-called: fail when tool absent' (deletion)
    'tool-called',
    // 'tool-not-called: fail when tool appears' (insertion)
    'tool-not-called',
    // 'tool-count ne: fail' / 'gt: fail' / 'lte: fail' (wrong count)
    'tool-count',
    // 'tool-before: fail when a is after b' (reorder)
    'tool-before',
    // 'skill-called: fail when skill never fired' (deletion)
    'skill-called',
    // 'skill-not-called: fail when skill present' (insertion)
    'skill-not-called',
    // 'skill-before-tool: fail when tool fires before skill' (reorder)
    'skill-before-tool',
    // 'skill-before-implementation-tool: fail when impl Edit before skill' (reorder)
    'skill-before-implementation-tool',
    // 'implementation-tool-not-called: fail when impl Edit present' (insertion)
    'implementation-tool-not-called',
    // 'investigated: fail when no investigation' (deletion)
    'investigated',
    // 'worktree-created: fail when neither present' (deletion)
    'worktree-created',
    // 'tool-match-before-tool-match: fail when B precedes A' (reorder; plus A-dropped leg)
    'tool-match-before-tool-match',
    // 'tool-arg-match (planted negative): calls with the wrong arg value fail, not broken'
    'tool-arg-match',
  ],
};

export const NEGATIVE_EXEMPT: {
  readonly fs: Readonly<Record<string, string>>;
  readonly transcript: Readonly<Record<string, string>>;
} = {
  fs: {
    // PRI-2506: codex is provisioned hook-less by design (skills are
    // discovered natively; no SessionStart bootstrap exists to verify).
    // verbCodexSessionStartHookExecutes in src/check/fs-verbs.ts is an
    // intentional always-pass stub kept so scenario vocabulary stays uniform
    // across harnesses — it has no failable target defect. Its always-pass
    // behavior is pinned by 'codex-session-start-hook-executes: always pass
    // with note' in both test files. If codex ever regains a SessionStart
    // bootstrap, remove this exemption and plant a real negative.
    'codex-session-start-hook-executes':
      'PRI-2506 design: codex is provisioned hook-less, so this verb is an intentional always-pass stub (src/check/fs-verbs.ts) with no failable target defect.',
  },
  transcript: {},
};
