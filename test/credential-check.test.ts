import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCredentials } from '../src/credentials/check.ts';

// Write a credentials YAML file into dir.
function writeCredentialsYaml(dir: string, content: string): string {
  const path = join(dir, 'credentials.yaml');
  writeFileSync(path, content);
  return path;
}

// Write a minimal valid agent YAML into the agents dir.
// family defaults to name if runtime_family is omitted; use a known family.
function writeAgentYaml(
  dir: string,
  name: string,
  extras: Record<string, string> = {},
): void {
  const lines = [
    `name: ${name}`,
    'binary: dummy',
    'home_config_subdir: .dummy',
    'session_log_dir: /tmp/sessions',
    'session_log_glob: "**/*.jsonl"',
    'normalizer: pi',
  ];
  for (const [k, v] of Object.entries(extras)) {
    lines.push(`${k}: ${v}`);
  }
  writeFileSync(join(dir, `${name}.yaml`), `${lines.join('\n')}\n`);
}

describe('checkCredentials', () => {
  test('passes when an agent has a valid default_credential listed in the credentials file', () => {
    const credsDir = mkdtempSync(join(tmpdir(), 'cred-check-creds-'));
    const agentsDir = mkdtempSync(join(tmpdir(), 'cred-check-agents-'));

    const credsPath = writeCredentialsYaml(
      credsDir,
      [
        'pi_default:',
        '  model: openai/gpt-4o',
        '  auth: oauth',
        '  harnesses: [pi]',
      ].join('\n'),
    );

    // name: pi — defaults runtime_family to "pi", which is a known family
    writeAgentYaml(agentsDir, 'pi', { default_credential: 'pi_default' });

    const result = checkCredentials(credsPath, agentsDir);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  test('fails when an agent default_credential names a missing credential', () => {
    const credsDir = mkdtempSync(join(tmpdir(), 'cred-check-creds-'));
    const agentsDir = mkdtempSync(join(tmpdir(), 'cred-check-agents-'));

    const credsPath = writeCredentialsYaml(
      credsDir,
      [
        'pi_default:',
        '  model: openai/gpt-4o',
        '  auth: oauth',
        '  harnesses: [pi]',
      ].join('\n'),
    );

    writeAgentYaml(agentsDir, 'pi', { default_credential: 'no_such_cred' });

    const result = checkCredentials(credsPath, agentsDir);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/pi/);
    expect(result.errors[0]).toMatch(/no_such_cred/);
    expect(result.errors[0]).toMatch(/not found/);
  });

  test('fails when a credential harnesses list omits the agent runtime family', () => {
    const credsDir = mkdtempSync(join(tmpdir(), 'cred-check-creds-'));
    const agentsDir = mkdtempSync(join(tmpdir(), 'cred-check-agents-'));

    const credsPath = writeCredentialsYaml(
      credsDir,
      [
        'some_cred:',
        '  model: openai/gpt-4o',
        '  auth: oauth',
        '  harnesses: [opencode]',
      ].join('\n'),
    );

    // pi family but credential only lists opencode
    writeAgentYaml(agentsDir, 'pi', { default_credential: 'some_cred' });

    const result = checkCredentials(credsPath, agentsDir);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/pi/);
    expect(result.errors[0]).toMatch(/some_cred/);
    expect(result.errors[0]).toMatch(/pi/); // harness name
  });

  test('surfaces parse error in errors array without throwing when credentials file is invalid', () => {
    const credsDir = mkdtempSync(join(tmpdir(), 'cred-check-creds-'));
    const agentsDir = mkdtempSync(join(tmpdir(), 'cred-check-agents-'));

    // bad-name uses a hyphen which violates the NAME_RE ^[a-z0-9_]+$ constraint
    const credsPath = writeCredentialsYaml(
      credsDir,
      [
        'bad-name:',
        '  model: openai/gpt-4o',
        '  auth: oauth',
        '  harnesses: [pi]',
      ].join('\n'),
    );

    const result = checkCredentials(credsPath, agentsDir);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // The error message must name the offending key so users can locate it
    expect(result.errors.join(' ')).toMatch(/bad-name/);
    // Should not throw; error must be in errors array
  });

  test('an agent without a default_credential does not contribute an error', () => {
    const credsDir = mkdtempSync(join(tmpdir(), 'cred-check-creds-'));
    const agentsDir = mkdtempSync(join(tmpdir(), 'cred-check-agents-'));

    // Empty credentials file (no credentials at all)
    const credsPath = writeCredentialsYaml(credsDir, '{}\n');

    // antigravity has no default_credential - use same-named agent
    // antigravity is a known family
    const lines = [
      'name: antigravity',
      'binary: agy',
      'home_config_subdir: "."',
      'session_log_dir: /tmp/sessions',
      'session_log_glob: "**/*.jsonl"',
      'normalizer: antigravity',
    ];
    writeFileSync(join(agentsDir, 'antigravity.yaml'), `${lines.join('\n')}\n`);

    const result = checkCredentials(credsPath, agentsDir);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  test('matches credential harness against runtime_family, not name', () => {
    // When an agent's `name` differs from its `runtime_family`, the harness
    // check must use runtime_family — otherwise agents like "claude-sonnet"
    // would never match a credential listing harnesses: [claude].
    const credsDir = mkdtempSync(join(tmpdir(), 'cred-check-creds-'));
    const agentsDir = mkdtempSync(join(tmpdir(), 'cred-check-agents-'));

    const credsPath = writeCredentialsYaml(
      credsDir,
      [
        'sonnet:',
        '  model: claude-sonnet',
        '  api: anthropic',
        '  harnesses: [claude]',
      ].join('\n'),
    );

    // Agent name is "claude-sonnet"; runtime_family overrides it to "claude".
    writeAgentYaml(agentsDir, 'claude-sonnet', {
      runtime_family: 'claude',
      default_credential: 'sonnet',
    });

    const result = checkCredentials(credsPath, agentsDir);
    expect(result).toEqual({ ok: true, errors: [] });
  });
});
