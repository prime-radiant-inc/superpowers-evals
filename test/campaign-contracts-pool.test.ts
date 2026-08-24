import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { poolKey } from '../src/contracts/campaign/pool.ts';
import type { Credential } from '../src/contracts/credential.ts';
import { parseCredentialsFile } from '../src/contracts/credential.ts';

test('v1 derivation: quota_pool, else (base_url ?? name)|api|model', () => {
  const base: Credential = {
    model: 'gpt-5.6-sol',
    api: 'openai-responses',
    base_url: 'https://api.openai.com/v1',
    auth: 'api-key',
    api_key_env: 'OPENAI_API_KEY',
    harnesses: ['codex'],
    compat: {},
  };
  expect(poolKey({ ...base }, 'openai_responses_56sol')).toBe(
    'https://api.openai.com/v1|openai-responses|gpt-5.6-sol',
  );
  expect(poolKey({ ...base, quota_pool: 'shared_bucket' }, 'whatever')).toBe(
    'shared_bucket',
  );
  // Name fallback when there is no base_url (native endpoints).
  expect(
    poolKey(
      {
        model: 'anthropic.claude-opus-4-8',
        api: 'mantle',
        auth: 'bedrock-bearer',
        harnesses: ['claude'],
        compat: {},
      },
      'opus_bedrock',
    ),
  ).toBe('opus_bedrock|mantle|anthropic.claude-opus-4-8');
});

test('golden fixtures: the function reproduces the gate manifest pool IDs', () => {
  // Hermetic on both sides: the gate-era credential snapshot (frozen rev
  // 64b99fc) and the committed Phase 0 manifest. Never recomputed from
  // today's credentials.yaml (Phase 0 plan's rule).
  const snapshot = parseCredentialsFile(
    parseYaml(
      readFileSync(
        join(import.meta.dir, 'fixtures', 'gate-era-credentials-64b99fc.yaml'),
        'utf8',
      ),
    ),
  );
  const manifest = JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        '..',
        'src',
        'campaign',
        'replay-manifest.gate-20260808.json',
      ),
      'utf8',
    ),
  ) as { comparisons: { credential: string; pool_id: string }[] };
  expect(manifest.comparisons.length).toBeGreaterThanOrEqual(4);
  for (const comparison of manifest.comparisons) {
    const cred = snapshot[comparison.credential];
    expect(cred).toBeDefined();
    if (cred !== undefined) {
      expect(poolKey(cred, comparison.credential)).toBe(comparison.pool_id);
    }
  }
});
