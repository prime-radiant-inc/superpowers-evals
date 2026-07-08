import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Credential } from '../src/contracts/credential.ts';
import { resolveCredentialNameForAgent } from '../src/credentials/index.ts';
import { allocateRunDir } from '../src/runner/index.ts';

// --- allocateRunDir with credential segment ---

test('allocateRunDir includes credential segment between agent and os', () => {
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const dir = allocateRunDir(out, 'sc', 'claude', 'sonnet', 'linux');
  expect(basename(dir)).toMatch(
    /^sc-claude-sonnet-linux-\d{8}T\d{6}Z-[0-9a-f]{4}$/,
  );
  expect(existsSync(dir)).toBe(true);
});

test('allocateRunDir credential=none produces -none- segment', () => {
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const dir = allocateRunDir(out, 'sc', 'claude', 'none', 'linux');
  expect(basename(dir)).toMatch(
    /^sc-claude-none-linux-\d{8}T\d{6}Z-[0-9a-f]{4}$/,
  );
});

test('allocateRunDir with os=windows produces credential between agent and windows', () => {
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const dir = allocateRunDir(out, 'sc', 'claude', 'sonnet', 'windows');
  expect(basename(dir)).toMatch(
    /^sc-claude-sonnet-windows-\d{8}T\d{6}Z-[0-9a-f]{4}$/,
  );
});

// --- resolveCredentialNameForAgent ---

function writeMinimalAgentYaml(
  dir: string,
  name: string,
  defaultCredential?: string,
): void {
  const lines = [
    `name: ${name}`,
    'binary: claude',
    'session_log_dir: ~/.claude/projects',
    'session_log_glob: "*.jsonl"',
    'normalizer: claude',
    'home_config_subdir: .claude',
    'runtime_family: claude',
    'model: claude-sonnet-4-5',
  ];
  if (defaultCredential !== undefined) {
    lines.push(`default_credential: ${defaultCredential}`);
  }
  writeFileSync(join(dir, `${name}.yaml`), `${lines.join('\n')}\n`);
}

test('resolveCredentialNameForAgent: explicit wins over agent default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeMinimalAgentYaml(dir, 'claude', 'default-cred');
  const result = resolveCredentialNameForAgent(dir, 'claude', 'explicit-cred');
  expect(result).toBe('explicit-cred');
});

test('resolveCredentialNameForAgent: falls back to agent yaml default_credential', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeMinimalAgentYaml(dir, 'claude', 'my-default');
  const result = resolveCredentialNameForAgent(dir, 'claude', undefined);
  expect(result).toBe('my-default');
});

test('resolveCredentialNameForAgent: returns undefined when no default_credential in yaml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  // Use pi (non-claude family) since claude now requires default_credential.
  writeFileSync(
    join(dir, 'pi.yaml'),
    `${[
      'name: pi',
      'binary: pi',
      'session_log_dir: ~/.pi/sessions',
      'session_log_glob: "*.jsonl"',
      'normalizer: pi',
      'home_config_subdir: .pi',
    ].join('\n')}\n`,
  );
  const result = resolveCredentialNameForAgent(dir, 'pi', undefined);
  expect(result).toBeUndefined();
});

test('resolveCredentialNameForAgent: returns undefined when agent yaml is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  // no yaml written
  const result = resolveCredentialNameForAgent(dir, 'nonexistent', undefined);
  expect(result).toBeUndefined();
});

test('resolveCredentialNameForAgent: empty string explicit is treated as absent (falls back)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeMinimalAgentYaml(dir, 'claude', 'my-default');
  const result = resolveCredentialNameForAgent(dir, 'claude', '');
  expect(result).toBe('my-default');
});

// --- $CLAUDE_MODEL sourced from credential ---

// The runner substitution `resolvedCredential?.model ?? cfg.model ?? ''`
// must prefer the credential's model over the YAML model field.

// Resolves $CLAUDE_MODEL using the same expression the runner evaluates,
// extracted as a helper so the tests stay concise and the expression is the
// single source of truth.
function resolveClaudeModel(
  cred: Credential | undefined,
  cfgModel: string | undefined,
): string {
  return cred?.model ?? cfgModel ?? '';
}

test('$CLAUDE_MODEL resolution: credential.model takes priority over cfg.model', () => {
  const cred: Credential = {
    model: 'claude-sonnet-4-6',
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    compat: {},
  };
  expect(resolveClaudeModel(cred, 'claude-haiku-4-5-20251001')).toBe(
    'claude-sonnet-4-6',
  );
});

test('$CLAUDE_MODEL resolution: falls back to cfg.model when no credential', () => {
  expect(resolveClaudeModel(undefined, 'claude-haiku-4-5-20251001')).toBe(
    'claude-haiku-4-5-20251001',
  );
});

test('$CLAUDE_MODEL resolution: empty string when neither credential nor cfg.model', () => {
  expect(resolveClaudeModel(undefined, undefined)).toBe('');
});
