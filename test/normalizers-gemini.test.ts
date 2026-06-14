import { expect, test } from 'bun:test';
import { normalizeGeminiLogs } from '../src/normalizers/gemini.ts';

// Mirrors quorum/normalizers.py
// TestNormalizeGeminiLogs::test_normalizes_activate_skill_name_argument_to_skill_name:
// an activate_skill call carrying a bare `name` arg gets a `skill` arg minted as
// superpowers:<name>, the original args preserved, and source `native`.
test('canonicalizes activate_skill name arg into a namespaced skill arg', () => {
  const raw = JSON.stringify({
    type: 'gemini',
    toolCalls: [
      {
        id: 'skill-1',
        name: 'activate_skill',
        args: { name: 'test-driven-development' },
      },
    ],
  });

  const rows = normalizeGeminiLogs(raw);

  expect(rows).toEqual([
    {
      tool: 'Skill',
      args: {
        name: 'test-driven-development',
        skill: 'superpowers:test-driven-development',
      },
      source: 'native',
    },
  ]);
});

// A skill arg that already carries a namespace (a ':') is passed through verbatim.
test('leaves an already-namespaced skill arg untouched', () => {
  const raw = JSON.stringify({
    type: 'gemini',
    toolCalls: [
      {
        id: 'skill-2',
        name: 'activate_skill',
        args: { skill: 'other:brainstorming' },
      },
    ],
  });

  const rows = normalizeGeminiLogs(raw);

  expect(rows).toEqual([
    {
      tool: 'Skill',
      args: { skill: 'other:brainstorming' },
      source: 'native',
    },
  ]);
});
