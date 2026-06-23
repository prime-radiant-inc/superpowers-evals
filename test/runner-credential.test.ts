import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
  writeMinimalAgentYaml(dir, 'claude'); // no default_credential
  const result = resolveCredentialNameForAgent(dir, 'claude', undefined);
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
