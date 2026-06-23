import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  injectUserPreference,
  instructionFileForAgent,
} from '../src/setup-helpers/user-preference.ts';

// The agent→ambient-instructions-file map is load-bearing: a user-override eval
// injects a preference into this file and checks the skill is suppressed. Write
// it to the WRONG file and the preference never loads → the eval silently
// false-passes. The map was established empirically by the canary probe
// (scenarios/probe-ambient-instruction-file, 2026-06-23), not from docs.
describe('instructionFileForAgent (probed map)', () => {
  test('verified mappings', () => {
    expect(instructionFileForAgent('claude')).toBe('CLAUDE.md');
    expect(instructionFileForAgent('codex')).toBe('AGENTS.md');
    expect(instructionFileForAgent('gemini')).toBe('GEMINI.md');
    // kimi reads AGENTS.md, NOT CLAUDE.md — probed; overturned the natural guess.
    expect(instructionFileForAgent('kimi')).toBe('AGENTS.md');
  });

  test('unmapped agent throws (fail loud — never silently no-op)', () => {
    // pi's ambient file is not yet verified (image bring-up pending); injecting
    // for it must error, not silently write nothing.
    expect(() => instructionFileForAgent('pi')).toThrow(/pi/);
    expect(() => instructionFileForAgent('')).toThrow();
  });
});

describe('injectUserPreference', () => {
  test('creates the agent ambient file and writes the preference', () => {
    const wd = mkdtempSync(join(tmpdir(), 'quorum-pref-'));
    injectUserPreference(wd, 'claude', 'Do not use the brainstorming skill.');
    const body = readFileSync(join(wd, 'CLAUDE.md'), 'utf8');
    expect(body).toContain('Do not use the brainstorming skill.');
  });

  test('appends to an existing instructions file rather than clobbering it', () => {
    const wd = mkdtempSync(join(tmpdir(), 'quorum-pref-'));
    writeFileSync(join(wd, 'AGENTS.md'), '# project notes\n', 'utf8');
    injectUserPreference(wd, 'kimi', 'Never do TDD on this project.');
    const body = readFileSync(join(wd, 'AGENTS.md'), 'utf8');
    expect(body).toContain('# project notes');
    expect(body).toContain('Never do TDD on this project.');
  });

  test('throws for an unmapped agent (does not silently skip)', () => {
    const wd = mkdtempSync(join(tmpdir(), 'quorum-pref-'));
    expect(() => injectUserPreference(wd, 'opencode', 'x')).toThrow();
    expect(existsSync(join(wd, 'AGENTS.md'))).toBe(false);
  });
});
