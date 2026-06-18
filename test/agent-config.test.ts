import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  AgentConfigSchema,
  agentConfigDir,
  CodingAgentConfigError,
  loadAgentConfig,
  resolveSessionLogDir,
  substituteEnv,
} from '../src/contracts/agent-config.ts';

// The claude fixtures list ANTHROPIC_API_KEY in required_env, and the loader now
// rejects unset required_env at load time (parity with Python). Set it for the
// happy-path fixtures; RX-4 uses a deliberately-unset var to assert the failure.
let prevKey: string | undefined;
beforeAll(() => {
  prevKey = process.env['ANTHROPIC_API_KEY'];
  process.env['ANTHROPIC_API_KEY'] = 'sk-test';
});
afterAll(() => {
  if (prevKey === undefined) {
    delete process.env['ANTHROPIC_API_KEY'];
  } else {
    process.env['ANTHROPIC_API_KEY'] = prevKey;
  }
});

// A claude.yaml whose only variable is the project_prompt reference.
function writeClaudeYaml(dir: string, projectPrompt: string | undefined): void {
  const lines = [
    'name: claude',
    'runtime_family: claude',
    'binary: claude',
    'home_config_subdir: ".claude"',
    'session_log_dir: "${QUORUM_AGENT_HOME}/.claude/projects"',
    'session_log_glob: "**/*.jsonl"',
    'normalizer: claude',
    'model: opus',
    'required_env:',
    '  - ANTHROPIC_API_KEY',
  ];
  if (projectPrompt !== undefined) {
    lines.push(`project_prompt: ${projectPrompt}`);
  }
  writeFileSync(join(dir, 'claude.yaml'), `${lines.join('\n')}\n`);
}

// Write an arbitrary <name>.yaml from explicit field lines (for the validation
// tests). Caller supplies the body lines; helper adds nothing implicitly.
function writeYaml(dir: string, name: string, lines: readonly string[]): void {
  writeFileSync(join(dir, `${name}.yaml`), `${lines.join('\n')}\n`);
}

const CLAUDE_BASE: readonly string[] = [
  'binary: claude',
  'home_config_subdir: ".claude"',
  'session_log_dir: "${QUORUM_AGENT_HOME}/.claude/projects"',
  'session_log_glob: "**/*.jsonl"',
  'normalizer: claude',
];

test('loads claude.yaml into a typed AgentConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeFileSync(
    join(dir, 'claude.yaml'),
    [
      'name: claude',
      'runtime_family: claude',
      'binary: claude',
      'home_config_subdir: ".claude"',
      'session_log_dir: "${QUORUM_AGENT_HOME}/.claude/projects"',
      'session_log_glob: "**/*.jsonl"',
      'normalizer: claude',
      'required_env:',
      '  - ANTHROPIC_API_KEY',
      'max_time: 10m',
      'model: opus',
    ].join('\n'),
  );
  const cfg = loadAgentConfig(dir, 'claude');
  expect(cfg.name).toBe('claude');
  expect(cfg.home_config_subdir).toBe('.claude');
  expect(cfg.required_env).toEqual(['ANTHROPIC_API_KEY']);
  expect(cfg.session_log_glob).toBe('**/*.jsonl');
  expect(cfg.max_concurrency).toBeUndefined();
});

test('substituteEnv replaces ${VAR} from a provided map', () => {
  expect(
    substituteEnv('${CLAUDE_CONFIG_DIR}/projects', {
      CLAUDE_CONFIG_DIR: '/tmp/cfg',
    }),
  ).toBe('/tmp/cfg/projects');
});

test('substituteEnv leaves unknown vars intact', () => {
  expect(substituteEnv('${UNKNOWN}/x', { OTHER: 'y' })).toBe('${UNKNOWN}/x');
});

test('loadAgentConfig resolves project_prompt to an absolute existing path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeFileSync(join(dir, 'claude.project-prompt.md'), '# prompt\n');
  writeClaudeYaml(dir, 'claude.project-prompt.md');
  const cfg = loadAgentConfig(dir, 'claude');
  expect(cfg.project_prompt).toBeDefined();
  // Resolved relative to the yaml dir, to an absolute path.
  expect(isAbsolute(cfg.project_prompt ?? '')).toBe(true);
  expect(cfg.project_prompt).toBe(join(dir, 'claude.project-prompt.md'));
});

test('loadAgentConfig errors when project_prompt does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  // No project-prompt file written.
  writeClaudeYaml(dir, 'claude.project-prompt.md');
  expect(() => loadAgentConfig(dir, 'claude')).toThrow(CodingAgentConfigError);
});

test('loadAgentConfig leaves project_prompt undefined when absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeClaudeYaml(dir, undefined);
  const cfg = loadAgentConfig(dir, 'claude');
  expect(cfg.project_prompt).toBeUndefined();
});

// RX-3 — name must equal the file stem.
test('loadAgentConfig rejects name != file stem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeYaml(dir, 'claude', [
    'name: notclaude',
    'runtime_family: claude',
    'model: opus',
    ...CLAUDE_BASE,
    'required_env: []',
  ]);
  expect(() => loadAgentConfig(dir, 'claude')).toThrow(
    /name must match file stem/,
  );
});

// RX-1 — runtime_family must be a known family; absent it defaults to the name.
test('loadAgentConfig rejects an unknown runtime_family', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeYaml(dir, 'claude', [
    'name: claude',
    'runtime_family: bogus',
    'model: opus',
    ...CLAUDE_BASE,
    'required_env: []',
  ]);
  expect(() => loadAgentConfig(dir, 'claude')).toThrow(
    /unknown runtime_family/,
  );
});

test('loadAgentConfig defaults runtime_family to name (known) when omitted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeYaml(dir, 'claude', [
    'name: claude',
    'model: opus',
    ...CLAUDE_BASE,
    'required_env: []',
  ]);
  // name "claude" is a known family; no runtime_family key -> loads fine.
  expect(() => loadAgentConfig(dir, 'claude')).not.toThrow();
});

// RX-2 — a claude family requires a non-blank model.
test('loadAgentConfig rejects a claude family with no model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeYaml(dir, 'claude', [
    'name: claude',
    'runtime_family: claude',
    ...CLAUDE_BASE,
    'required_env: []',
  ]);
  expect(() => loadAgentConfig(dir, 'claude')).toThrow(/requires model/);
});

test('loadAgentConfig rejects a blank model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeYaml(dir, 'claude', [
    'name: claude',
    'runtime_family: claude',
    'model: "   "',
    ...CLAUDE_BASE,
    'required_env: []',
  ]);
  expect(() => loadAgentConfig(dir, 'claude')).toThrow(
    /model must not be blank/,
  );
});

// RX-4 — required_env must be set (non-empty) at load time.
test('loadAgentConfig rejects an unset required_env var', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeYaml(dir, 'claude', [
    'name: claude',
    'runtime_family: claude',
    'model: opus',
    ...CLAUDE_BASE,
    'required_env:',
    '  - QUORUM_DEFINITELY_UNSET_RX4',
  ]);
  expect(() => loadAgentConfig(dir, 'claude')).toThrow(/required env/);
});

// RX-5 — substituteEnv also handles bare $VAR and $$; resolveSessionLogDir
// expands a leading ~.
test('substituteEnv replaces bare $VAR from a provided map', () => {
  expect(
    substituteEnv('$CLAUDE_CONFIG_DIR/projects', { CLAUDE_CONFIG_DIR: '/c' }),
  ).toBe('/c/projects');
});

test('substituteEnv unescapes $$ to a literal $', () => {
  expect(substituteEnv('a$$b', {})).toBe('a$b');
});

test('substituteEnv leaves a lone $ and unknown bare $VAR intact', () => {
  expect(substituteEnv('cost is $ and $UNKNOWN', { OTHER: 'y' })).toBe(
    'cost is $ and $UNKNOWN',
  );
});

test('resolveSessionLogDir substitutes then expands a leading ~', () => {
  expect(resolveSessionLogDir('~/logs/${X}', { X: 'run' })).toBe(
    join(homedir(), 'logs/run'),
  );
});

test('resolveSessionLogDir leaves a non-leading ~ untouched', () => {
  expect(resolveSessionLogDir('/a/~/b', {})).toBe('/a/~/b');
});

// home_config_subdir is required: every agent runs in the throwaway $HOME with
// its config collapsed under it, so a yaml omitting the key is a config error
// (not a silent fall-back to a standalone dir).
test('AgentConfigSchema requires home_config_subdir', () => {
  expect(() =>
    AgentConfigSchema.parse({
      name: 'x',
      binary: 'x',
      session_log_dir: '${QUORUM_AGENT_HOME}/sessions',
      session_log_glob: '*.jsonl',
      normalizer: 'x',
    }),
  ).toThrow();
});

// agentConfigDir — the throwaway-$HOME config collapse seam.
const CONFIG_DIR_BASE = AgentConfigSchema.parse({
  name: 'x',
  binary: 'x',
  home_config_subdir: '.',
  session_log_dir: '${QUORUM_AGENT_HOME}/sessions',
  session_log_glob: '*.jsonl',
  normalizer: 'x',
});

test('agentConfigDir: a config-dir-like subdir roots under the throwaway home', () => {
  const cfg = { ...CONFIG_DIR_BASE, home_config_subdir: '.codex' };
  expect(agentConfigDir(cfg, '/run/home')).toBe(join('/run/home', '.codex'));
});

test('agentConfigDir: "." means the throwaway home itself (a HOME-like var)', () => {
  const cfg = { ...CONFIG_DIR_BASE, home_config_subdir: '.' };
  expect(agentConfigDir(cfg, '/run/home')).toBe('/run/home');
});
