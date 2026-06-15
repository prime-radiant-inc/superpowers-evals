import { expect, test } from 'bun:test';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeAntigravity } from '../src/normalize/antigravity.ts';

// ---------------------------------------------------------------------------
// Fixtures — derived from quorum/normalizers.py and tests/quorum/test_normalizers.py
// ---------------------------------------------------------------------------

function names(traj: ReturnType<typeof normalizeAntigravity>): string[] {
  return traj.steps
    .filter((s) => s.source === 'agent')
    .map((s) => s.tool_calls![0]!.function_name);
}

function args(
  traj: ReturnType<typeof normalizeAntigravity>,
  i: number,
): Record<string, unknown> {
  return traj.steps.filter((s) => s.source === 'agent')[i]!.tool_calls![0]!
    .arguments;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('produces a valid ATIF v1.7 trajectory', () => {
  const raw = JSON.stringify({
    tool_calls: [{ name: 'run_command', args: { CommandLine: 'pytest -q' } }],
  });
  const traj = normalizeAntigravity(raw, '0.1.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe('ATIF-v1.7');
  expect(traj.agent).toEqual({ name: 'antigravity', version: '0.1.0' });
});

test('normalizes top-level tool_calls and PascalCase args', () => {
  const raw = [
    JSON.stringify({
      type: 'assistant',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: 'pytest -q' } },
        {
          name: 'view_file',
          args: {
            AbsolutePath:
              '/tmp/run/.gemini/config/plugins/superpowers/skills/test-driven-development/SKILL.md',
            IsSkillFile: true,
          },
        },
        { name: 'list_dir', args: { DirectoryPath: 'src' } },
      ],
    }),
    'not json',
    JSON.stringify({ type: 'assistant', text: 'no tools here' }),
  ].join('\n');

  const traj = normalizeAntigravity(raw, '0.1.0');
  expect(names(traj)).toEqual(['Bash', 'Read', 'Glob']);
  expect(args(traj, 0)['command']).toBe('pytest -q');
  expect(args(traj, 0)['raw_args']).toEqual({ CommandLine: 'pytest -q' });
  expect(String(args(traj, 1)['file_path'])).toEndWith(
    '/skills/test-driven-development/SKILL.md',
  );
  expect(args(traj, 1)['is_skill_file']).toBe(true);
  expect(
    (args(traj, 1)['raw_args'] as Record<string, unknown>)['IsSkillFile'],
  ).toBe(true);
  expect(args(traj, 2)['path']).toBe('src');
});

test('decodes JSON string-literal args', () => {
  const raw = JSON.stringify({
    tool_calls: [
      {
        name: 'view_file',
        args: {
          AbsolutePath:
            '"/tmp/run/.gemini/config/plugins/superpowers/skills/brainstorming/SKILL.md"',
          toolSummary: '"Read brainstorming skill"',
        },
      },
      {
        name: 'run_command',
        args: { CommandLine: '"pytest -q"', Cwd: '"/tmp/run"' },
      },
      { name: 'list_dir', args: { DirectoryPath: '"/tmp/run/src"' } },
    ],
  });
  const traj = normalizeAntigravity(raw, '0.1.0');
  expect(args(traj, 0)['file_path']).toBe(
    '/tmp/run/.gemini/config/plugins/superpowers/skills/brainstorming/SKILL.md',
  );
  expect(
    String(
      (args(traj, 0)['raw_args'] as Record<string, unknown>)['AbsolutePath'],
    ),
  ).toStartWith('"');
  expect(args(traj, 1)['command']).toBe('pytest -q');
  expect(args(traj, 1)['cwd']).toBe('/tmp/run');
  expect(args(traj, 2)['path']).toBe('/tmp/run/src');
});

test('normalizes write and edit target paths', () => {
  const raw = JSON.stringify({
    tool_calls: [
      {
        name: 'write_to_file',
        args: { TargetFile: '"/tmp/run/coding-agent-workdir/src/app.js"' },
      },
      {
        name: 'replace_file_content',
        args: { TargetFile: '"/tmp/run/coding-agent-workdir/src/app.js"' },
      },
    ],
  });
  const traj = normalizeAntigravity(raw, '0.1.0');
  expect(names(traj)).toEqual(['Write', 'Edit']);
  expect(args(traj, 0)['file_path']).toBe(
    '/tmp/run/coding-agent-workdir/src/app.js',
  );
  expect(args(traj, 1)['file_path']).toBe(
    '/tmp/run/coding-agent-workdir/src/app.js',
  );
  expect(
    String(
      (args(traj, 0)['raw_args'] as Record<string, unknown>)['TargetFile'],
    ),
  ).toStartWith('"');
});

test('normalizes nested PLANNER_RESPONSE tool_calls', () => {
  const raw = JSON.stringify({
    PLANNER_RESPONSE: {
      tool_calls: [
        { name: 'write_to_file', args: { Path: 'src/app.py' } },
        { name: 'replace_file_content', args: { path: 'src/app.py' } },
        { name: 'grep_search', args: { pattern: 'validate' } },
      ],
    },
  });
  const traj = normalizeAntigravity(raw, '0.1.0');
  expect(names(traj)).toEqual(['Write', 'Edit', 'Grep']);
  expect(
    traj.steps
      .filter((s) => s.source === 'agent')
      .every((s) => 'raw_args' in s.tool_calls![0]!.arguments),
  ).toBe(true);
});

test('normalizes lowercase args and camelCase tool-call container shapes', () => {
  const raw = [
    JSON.stringify({
      toolCalls: [
        { name: 'run_command', args: { command: 'pytest' } },
        { name: 'list_dir', args: { directory_path: 'src' } },
        { name: 'list_dir', args: { path: 'tests' } },
      ],
    }),
    JSON.stringify({
      planner_response: {
        toolCalls: [{ name: 'view_file', args: { filePath: 'src/app.py' } }],
      },
    }),
  ].join('\n');
  const traj = normalizeAntigravity(raw, '0.1.0');
  expect(names(traj)).toEqual(['Bash', 'Glob', 'Glob', 'Read']);
  expect(args(traj, 0)['command']).toBe('pytest');
  expect(args(traj, 1)['path']).toBe('src');
  expect(args(traj, 2)['path']).toBe('tests');
  expect(args(traj, 3)['file_path']).toBe('src/app.py');
});

test('normalizes documented aliases and preserves unknown find tools', () => {
  const raw = JSON.stringify({
    tool_calls: [
      { name: 'create_file', args: { Path: 'new.py' } },
      { name: 'multi_replace_file_content', args: { path: 'existing.py' } },
      { name: 'edit_file', args: { path: 'existing.py' } },
      { name: 'search_directory', args: { query: 'needle' } },
      { name: 'find_by_name', args: { name: 'README.md' } },
      { name: 'find_file', args: { name: 'pyproject.toml' } },
      { name: 'find_symbol', args: { symbol: 'validate' } },
      { name: 'list_directory', args: { path: 'src' } },
      { name: 'search_web', args: { query: 'docs' } },
      { name: 'read_url_content', args: { url: 'https://example.test' } },
    ],
  });
  const traj = normalizeAntigravity(raw, '0.1.0');
  expect(names(traj)).toEqual([
    'Write',
    'Edit',
    'Edit',
    'Grep',
    'Glob',
    'Glob',
    'find_symbol',
    'Glob',
    'WebSearch',
    'WebFetch',
  ]);
  expect(args(traj, 6)['raw_args']).toEqual({ symbol: 'validate' });
});

test('preserves unknown tools and non-launch manage subagents', () => {
  const raw = JSON.stringify({
    tool_calls: [
      { name: 'unknown_tool', args: { x: 1 } },
      { name: 'manage_subagents', args: { action: 'list' } },
      { name: 'invoke_subagent', args: { prompt: 'review this' } },
    ],
  });
  const traj = normalizeAntigravity(raw, '0.1.0');
  expect(names(traj)).toEqual(['unknown_tool', 'manage_subagents', 'Agent']);
  expect(args(traj, 0)['raw_args']).toEqual({ x: 1 });
  expect(args(traj, 1)['raw_args']).toEqual({ action: 'list' });
});

test('ignores non-string tool names', () => {
  const raw = JSON.stringify({
    tool_calls: [
      { name: 123, args: { x: 1 } },
      { name: 'run_command', args: { command: 'pytest -q' } },
    ],
  });
  const traj = normalizeAntigravity(raw, '0.1.0');
  expect(names(traj)).toEqual(['Bash']);
  expect(args(traj, 0)['command']).toBe('pytest -q');
});

test('canonicalizes skill marker casing and nested metadata', () => {
  const raw = JSON.stringify({
    tool_calls: [
      {
        name: 'view_file',
        args: {
          Path: '/x/skills/superpowers/brainstorming/SKILL.md',
          metadata: { isSkillFile: true },
        },
      },
    ],
  });
  const traj = normalizeAntigravity(raw, '0.1.0');
  expect(names(traj)).toEqual(['Read']);
  expect(args(traj, 0)['file_path']).toBe(
    '/x/skills/superpowers/brainstorming/SKILL.md',
  );
  expect(args(traj, 0)['is_skill_file']).toBe(true);
});

// ---------------------------------------------------------------------------
// Usage guard (ATIF usage-unification contract, 2026-06-15)
//
// Antigravity transcripts carry NO token usage anywhere (verified against
// /tmp/quorum-live-results4/...-antigravity-.../**/transcript.jsonl and
// docs/experiments/2026-06-15-coding-agent-token-capture.md). The normalizer
// must NOT fabricate metrics: every step.metrics / model_name stays unset and
// trajectory.final_metrics stays absent.
// ---------------------------------------------------------------------------

const realNoUsage = await Bun.file(
  new URL('./fixtures/antigravity-real-no-usage.jsonl', import.meta.url),
).text();

test('real antigravity transcript carries no usage metrics', () => {
  const traj = normalizeAntigravity(realNoUsage, '0.1.0');
  expect(validateTrajectory(traj).ok).toBe(true);
  // It DID find tool calls (proves the log was parsed, not empty).
  expect(traj.steps.some((s) => s.tool_calls)).toBe(true);
  // ...but no usage was invented.
  for (const step of traj.steps) {
    expect(step.metrics).toBeUndefined();
    expect(step.model_name).toBeUndefined();
  }
  expect(traj.final_metrics).toBeUndefined();
  expect(traj.agent.model_name).toBeUndefined();
});

test('synthetic transcript with tool calls produces no metrics', () => {
  const raw = [
    JSON.stringify({
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'pytest -q' } }],
    }),
    JSON.stringify({
      PLANNER_RESPONSE: {
        tool_calls: [{ name: 'write_to_file', args: { Path: 'src/app.py' } }],
      },
    }),
  ].join('\n');
  const traj = normalizeAntigravity(raw, '0.1.0');
  expect(traj.steps.every((s) => s.metrics === undefined)).toBe(true);
  expect(traj.final_metrics).toBeUndefined();
});
