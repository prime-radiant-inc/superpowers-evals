// test/setup-helpers-registry.test.ts
import { describe, expect, test } from 'bun:test';
import { KNOWN_HELPER_NAMES, REGISTRY } from '../src/setup-helpers/registry.ts';

describe('registry', () => {
  test('has 37 dispatchable helpers', () => {
    expect(Object.keys(REGISTRY).length).toBe(37);
  });
  test('library-only fns are not dispatchable', () => {
    expect(REGISTRY['add_worktree']).toBeUndefined();
    expect(REGISTRY['detach_head']).toBeUndefined();
  });
  test('KNOWN_HELPER_NAMES has all 39 keys incl. the 2 library names', () => {
    // Validation parity with Python HELPER_REGISTRY (used by `quorum check`).
    expect(KNOWN_HELPER_NAMES.size).toBe(39);
    expect(KNOWN_HELPER_NAMES.has('add_worktree')).toBe(true);
    expect(KNOWN_HELPER_NAMES.has('detach_head')).toBe(true);
    for (const k of Object.keys(REGISTRY)) {
      expect(KNOWN_HELPER_NAMES.has(k)).toBe(true);
    }
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
  });
});
