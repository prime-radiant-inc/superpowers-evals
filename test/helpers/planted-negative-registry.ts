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
// - A verb belongs in NEGATIVE_COVERED only if a committed test drives it
//   through the real CLI record path (runShim in test/check-tool.test.ts /
//   runCLI in test/check-transcript.test.ts — the helpers that emit actual
//   {check,args,negated,passed,detail} records) against a real defect fixture
//   and asserts BOTH passed === false AND negated === false on the emitted
//   record. Direct verbX invocation alone cannot prove this: `negated` is a
//   dispatch-layer field invisible to the verb functions. Each entry's
//   comment names the test.
// - NEGATIVE_EXEMPT is only for verbs that structurally cannot return
//   passed:false (documented always-pass stubs). Every exemption must cite its
//   design note; the gate enforces a non-empty reason so exemptions stay loud.
// - A verb may NEVER appear in both lists: a real negative must force its
//   exemption out (the gates reject the overlap by name).
// - Both lists are checked for staleness by the gates: a registered verb that
//   no longer exists in its vocabulary fails the gate.

/**
 * The shared gate body: collect every coverage problem for one family as
 * human-readable strings. Consumed by the coverage-gate tests in
 * test/check-tool.test.ts (family 'fs') and test/check-transcript.test.ts
 * (family 'transcript'), and by the overlap-rejection tests that prove the
 * gates refuse covered-and-exempt verbs. A red gate joins these with '; '.
 */
export function coverageProblems(args: {
  readonly family: 'fs' | 'transcript';
  readonly vocab: readonly string[];
  readonly covered: readonly string[];
  readonly exempt: Readonly<Record<string, string>>;
}): string[] {
  const { family, vocab, covered, exempt } = args;
  const problems: string[] = [];
  for (const verb of vocab) {
    if (!covered.includes(verb) && !Object.hasOwn(exempt, verb)) {
      problems.push(`${family} verb lacks planted negative: ${verb}`);
    }
  }
  // Overlap is rejected: a verb with a real planted negative must not keep an
  // always-pass exemption — the exemption would let the negative be deleted
  // later without the gate noticing.
  for (const verb of covered) {
    if (Object.hasOwn(exempt, verb)) {
      problems.push(`${family} verb is both covered and exempt: ${verb}`);
    }
  }
  // Exemptions must never be silent: each needs a non-empty reason citing
  // the design note that makes the verb structurally unfailable.
  for (const [verb, reason] of Object.entries(exempt)) {
    if (!/\S/.test(reason)) {
      problems.push(`exemption for ${verb} needs a non-empty reason`);
    }
  }
  // Stale registrations are loud too: every registry entry must name a verb
  // that actually exists in the vocabulary.
  for (const verb of covered) {
    if (!vocab.includes(verb)) {
      problems.push(`registry names unknown ${family} verb: ${verb}`);
    }
  }
  for (const verb of Object.keys(exempt)) {
    if (!vocab.includes(verb)) {
      problems.push(`exemption names unknown ${family} verb: ${verb}`);
    }
  }
  return problems;
}

export const NEGATIVE_COVERED: {
  readonly fs: readonly string[];
  readonly transcript: readonly string[];
} = {
  // Each entry names the CLI-path test (real runShim/runCLI emission)
  // that asserts passed:false AND negated:false against a real defect —
  // all in test/check-tool.test.ts unless noted otherwise.
  fs: [
    // test/brainstorming-evidence.test.ts: 'real scenario setup and post checks
    // preserve pass, fail, and missing-evidence outcomes' drives runPhase's real
    // prelude/CLI and asserts a non-negated failure for missing execution choice.
    'brainstorming-review',
    // 'E2E planted negative: baseline-manifest fails on a drifted worktree'
    'baseline-manifest',
    // 'E2E: file-exists miss exits 1 with a detail string'
    'file-exists',
    // 'E2E planted negative: file-contains fails on a file lacking the needle'
    'file-contains',
    // 'E2E planted negative: command-succeeds fails on a false command'
    'command-succeeds',
    // 'E2E planted negative: git-repo fails outside a work tree'
    'git-repo',
    // 'E2E planted negative: git-branch fails on a branch mismatch'
    'git-branch',
    // 'E2E planted negative: git-clean fails on a dirty tree'
    'git-clean',
    // 'E2E planted negative: git-count fails on a wrong expected count'
    'git-count',
    // 'E2E planted negative: assert-checkout-clean fails on real drift'
    'assert-checkout-clean',
    // 'E2E planted negative: requires-tool fails when the tool is missing'
    'requires-tool',
    // 'E2E planted negative: files-exist fails when a rel is missing'
    'files-exist',
    // 'E2E planted negative: antigravity-plugin-installed fails when a staged file is missing'
    'antigravity-plugin-installed',
    // 'E2E planted negative: copilot-plugin-installed fails when a staged file is missing'
    'copilot-plugin-installed',
    // 'E2E planted negative: opencode-plugin-installed fails when a staged file is missing'
    'opencode-plugin-installed',
    // 'E2E planted negative: gemini-extension-linked fails when a staged file is missing'
    'gemini-extension-linked',
    // 'E2E planted negative: hermes-plugin-staged fails when a staged file is missing'
    'hermes-plugin-staged',
    // 'E2E planted negative: kimi-plugin-installed fails when installed.json is missing'
    'kimi-plugin-installed',
    // 'E2E planted negative: codex-native-hook-configured fails when the staged manifest is missing'
    'codex-native-hook-configured',
    // 'E2E planted negative: bootstrap-installed fails when the harness install is absent'
    'bootstrap-installed',
  ],
  // Transcript CLI-path negatives live in test/check-transcript.test.ts.
  transcript: [
    // 'tool-called: fail (E2E)' (deletion: call never made)
    'tool-called',
    // 'E2E planted negative: tool-not-called fails when the prohibited call is present (insertion)'
    'tool-not-called',
    // 'E2E planted negative: tool-count fails on a wrong expected count'
    'tool-count',
    // 'E2E planted negative: tool-before fails when the order is reversed (reorder)'
    'tool-before',
    // 'skill-called: fail (E2E)' (deletion: skill never fired)
    'skill-called',
    // 'E2E planted negative: skill-not-called fails when the skill fired (insertion)'
    'skill-not-called',
    // 'E2E planted negative: skill-before-tool fails when the tool precedes the skill (reorder)'
    'skill-before-tool',
    // 'E2E planted negative: skill-before-implementation-tool fails when impl Edit precedes the skill (reorder)'
    'skill-before-implementation-tool',
    // 'E2E planted negative: implementation-tool-not-called fails when an impl Edit is present (insertion)'
    'implementation-tool-not-called',
    // 'E2E planted negative: investigated fails when no investigation happened (deletion)'
    'investigated',
    // 'E2E planted negative: worktree-created fails when no worktree call exists (deletion)'
    'worktree-created',
    // 'E2E planted negative: tool-match-before-tool-match fails when B precedes A (reorder)'
    'tool-match-before-tool-match',
    // 'tool-arg-match (planted negative): calls with the wrong arg value fail, not broken' (insertion)
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
    // across harnesses — it has no failable target defect, so it can never
    // appear in NEGATIVE_COVERED (the gates reject the overlap). Its
    // always-pass behavior is pinned by 'codex-session-start-hook-executes:
    // always pass with note' in both test files. If codex ever regains a
    // SessionStart bootstrap, remove this exemption and plant a real negative.
    'codex-session-start-hook-executes':
      'PRI-2506 design: codex is provisioned hook-less, so this verb is an intentional always-pass stub (src/check/fs-verbs.ts) with no failable target defect.',
  },
  transcript: {},
};
