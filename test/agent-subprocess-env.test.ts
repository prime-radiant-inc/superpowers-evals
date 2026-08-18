import { expect, test } from 'bun:test';
import {
  PROVISION_ENV_ALLOWLIST,
  provisionSubprocessEnv,
} from '../src/agents/subprocess-env.ts';

// Hostile credential-shaped vars that must NEVER reach an adapter provisioning
// subprocess. Set/restore happens inside each test (save/restore, never a bare
// afterEach delete — a bare delete would destroy a host variable that was
// legitimately set before the test ran; this mirrors the Task 1 fix).
const HOSTILE = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'KIMI_MODEL_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
];

test('provisionSubprocessEnv projects the allowlist and overlays extras', () => {
  const saved: Record<string, string | undefined> = {};
  for (const name of HOSTILE) {
    saved[name] = process.env[name];
    process.env[name] = `hostile-${name}`;
  }
  try {
    const env = provisionSubprocessEnv({ MY_EXTRA: 'x' });
    for (const name of HOSTILE) expect(env[name]).toBeUndefined();
    expect(env['MY_EXTRA']).toBe('x');
    expect(env['PATH']).toBe(process.env['PATH']);
    // extras override base names:
    expect(provisionSubprocessEnv({ HOME: '/run/home' })['HOME']).toBe(
      '/run/home',
    );
  } finally {
    for (const name of HOSTILE) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

// The exact-list contract (Fix Rounds 1–2): the shared list is the exact union
// of non-secret names with per-name ACTIVE-COMMAND evidence across the
// in-scope commands (both agy calls, gemini extensions link/list, hermes
// plugins enable, node --check, gh auth token, sshpass/ssh/scp) — see the
// evidence record in src/agents/subprocess-env.ts and task-2-report.md Fix
// Rounds 1–2. A name may only be added together with that evidence; this
// regression makes an unevidenced re-add fail the gate instead of leaking
// silently.
test('PROVISION_ENV_ALLOWLIST is exactly the active-command-evidenced union', () => {
  expect([...PROVISION_ENV_ALLOWLIST]).toEqual([
    'GH_CONFIG_DIR',
    'GH_HOST',
    'HOME',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'PATH',
    'XDG_CONFIG_HOME',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ]);
});

test('PROVISION_ENV_ALLOWLIST contains no credential-shaped names', () => {
  for (const name of PROVISION_ENV_ALLOWLIST) {
    expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i);
  }
});
