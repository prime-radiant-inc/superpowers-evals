// test/setup-helpers-registry.test.ts
import { describe, expect, test } from 'bun:test';
import { KNOWN_HELPER_NAMES, REGISTRY } from '../src/setup-helpers/registry.ts';

describe('registry', () => {
  test('library-only fns are not dispatchable', () => {
    expect(REGISTRY['add_worktree']).toBeUndefined();
    expect(REGISTRY['detach_head']).toBeUndefined();
  });
  test('KNOWN_HELPER_NAMES is the dispatchable set plus the 2 library names', () => {
    // Validation parity with Python HELPER_REGISTRY (used by `quorum check`).
    // Assert the relationship to REGISTRY, never a hardcoded count, so adding or
    // removing a scenario helper doesn't churn this test.
    for (const k of Object.keys(REGISTRY)) {
      expect(KNOWN_HELPER_NAMES.has(k)).toBe(true);
    }
    expect(KNOWN_HELPER_NAMES.has('add_worktree')).toBe(true);
    expect(KNOWN_HELPER_NAMES.has('detach_head')).toBe(true);
    // No stray names beyond the dispatchable helpers and the 2 library names.
    expect(KNOWN_HELPER_NAMES.size).toBe(Object.keys(REGISTRY).length + 2);
  });
  test('declares template/superpowers needs correctly', () => {
    expect(REGISTRY['create_base_repo']?.needsTemplateDir).toBe(true);
    expect(REGISTRY['symlink_superpowers']?.needsSuperpowersRoot).toBe(true);
    expect(REGISTRY['link_gemini_extension']?.needsSuperpowersRoot).toBe(true);
    expect(
      REGISTRY['install_codex_superpowers_plugin_hooks']?.needsSuperpowersRoot,
    ).toBe(true);
    expect(
      REGISTRY['create_cost_clean_repo']?.needsTemplateDir,
    ).toBeUndefined();
    expect(REGISTRY['init_repo_from_fixtures']?.needsScenarioDir).toBe(true);
  });
});
