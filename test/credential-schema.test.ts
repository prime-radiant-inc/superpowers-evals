import { describe, expect, test } from 'bun:test';
import {
  CredentialSchema,
  parseCredentialsFile,
} from '../src/contracts/credential.ts';

describe('CredentialSchema', () => {
  test('minimal credential needs model + harnesses; defaults applied', () => {
    const c = CredentialSchema.parse({
      model: 'gpt-5.5',
      harnesses: ['opencode'],
    });
    expect(c.api).toBe('openai-chat');
    expect(c.auth).toBe('api-key');
    expect(c.compat).toEqual({});
  });
  test('optional provider is parsed (pi OAuth provider pin)', () => {
    const c = CredentialSchema.parse({
      model: 'gpt-5.5',
      harnesses: ['pi'],
      auth: 'oauth',
      provider: 'openai-codex',
    });
    expect(c.provider).toBe('openai-codex');
    const d = CredentialSchema.parse({ model: 'm', harnesses: ['pi'] });
    expect(d.provider).toBeUndefined();
  });
  test('rejects empty harnesses', () => {
    expect(() =>
      CredentialSchema.parse({ model: 'm', harnesses: [] }),
    ).toThrow();
  });
  test('rejects unknown api', () => {
    expect(() =>
      CredentialSchema.parse({ model: 'm', harnesses: ['pi'], api: 'soap' }),
    ).toThrow();
  });
  test('rejects unknown compat key', () => {
    expect(() =>
      CredentialSchema.parse({
        model: 'm',
        harnesses: ['pi'],
        compat: { nope: 1 },
      }),
    ).toThrow();
  });
  test('accepts boolean tool-choice compatibility and rejects other types', () => {
    expect(
      CredentialSchema.parse({
        model: 'openrouter/@preset/example-version',
        harnesses: ['serf'],
        compat: { tool_choice_auto_only: true },
      }).compat.tool_choice_auto_only,
    ).toBe(true);
    expect(() =>
      CredentialSchema.parse({
        model: 'openrouter/@preset/example-version',
        harnesses: ['serf'],
        compat: { tool_choice_auto_only: 'yes' },
      }),
    ).toThrow();
  });
  test('parseCredentialsFile enforces name charset', () => {
    expect(() =>
      parseCredentialsFile({ 'bad-name': { model: 'm', harnesses: ['pi'] } }),
    ).toThrow(/[a-z0-9_]/);
  });

  test('parseCredentialsFile rejects reserved prototype names', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      expect(() =>
        parseCredentialsFile({ [name]: { model: 'm', harnesses: ['serf'] } }),
      ).toThrow(/reserved/);
    }
  });

  test('accepts strict campaign labels and rejects undeclared credentials', () => {
    const labeled = {
      model: 'openrouter/@preset/example-version',
      api: 'openai-chat',
      base_url: 'https://openrouter.ai/api/v1',
      api_key_env: 'OPENROUTER_API_KEY',
      harnesses: ['serf'],
      labels: {
        model: 'example/model',
        provider: 'example-provider',
        quantization: 'fp8',
        preset_id: '00000000-0000-4000-8000-000000000002',
        preset_version_id: '00000000-0000-4000-8000-000000000001',
        is_byok: false,
        catalog_as_of: '2026-07-10',
      },
    };

    expect(CredentialSchema.parse(labeled).labels?.provider).toBe(
      'example-provider',
    );
    expect(() =>
      CredentialSchema.parse({ ...labeled, unexpected: true }),
    ).toThrow();
    expect(() =>
      CredentialSchema.parse({
        ...labeled,
        labels: { ...labeled.labels, extra: 'rejected' },
      }),
    ).toThrow();
    expect(() =>
      CredentialSchema.parse({
        ...labeled,
        labels: { ...labeled.labels, quantization: 'unknown' },
      }),
    ).toThrow();
    expect(() =>
      CredentialSchema.parse({ ...labeled, api_key_env: 'BAD-NAME' }),
    ).toThrow();
  });

  test('rejects incomplete and invalid campaign label values', () => {
    const labeled = {
      model: 'openrouter/@preset/example-version',
      harnesses: ['serf'],
      labels: {
        model: 'example/model',
        provider: 'example-provider',
        quantization: 'fp8',
        preset_id: '00000000-0000-4000-8000-000000000002',
        preset_version_id: '00000000-0000-4000-8000-000000000001',
        is_byok: false,
        catalog_as_of: '2026-07-10',
      },
    };

    expect(() =>
      CredentialSchema.parse({
        ...labeled,
        labels: { model: 'example/model' },
      }),
    ).toThrow();
    expect(() =>
      CredentialSchema.parse({
        ...labeled,
        labels: { ...labeled.labels, provider: 'Example Provider' },
      }),
    ).toThrow();
    expect(() =>
      CredentialSchema.parse({
        ...labeled,
        labels: { ...labeled.labels, quantization: 'fp 8' },
      }),
    ).toThrow();
    for (const quantization of ['UNKNOWN', 'unverified']) {
      expect(() =>
        CredentialSchema.parse({
          ...labeled,
          labels: { ...labeled.labels, quantization },
        }),
      ).toThrow();
    }
    expect(() =>
      CredentialSchema.parse({
        ...labeled,
        labels: { ...labeled.labels, preset_id: 'not-a-uuid' },
      }),
    ).toThrow();
    expect(() =>
      CredentialSchema.parse({
        ...labeled,
        labels: { ...labeled.labels, preset_version_id: 'not-a-uuid' },
      }),
    ).toThrow();
    expect(() =>
      CredentialSchema.parse({
        ...labeled,
        labels: { ...labeled.labels, is_byok: 'false' },
      }),
    ).toThrow();
    expect(() =>
      CredentialSchema.parse({
        ...labeled,
        labels: { ...labeled.labels, catalog_as_of: '2026-07-32' },
      }),
    ).toThrow();
    expect(() =>
      CredentialSchema.parse({ ...labeled, api_key_env: '1INVALID' }),
    ).toThrow();
  });

  test('rejects terminal control characters in campaign model labels', () => {
    const labeled = {
      model: 'openrouter/@preset/example-version',
      harnesses: ['serf'],
      labels: {
        model: 'example/model',
        provider: 'example-provider',
        quantization: 'fp8',
        preset_id: '00000000-0000-4000-8000-000000000002',
        preset_version_id: '00000000-0000-4000-8000-000000000001',
        is_byok: false,
        catalog_as_of: '2026-07-10',
      },
    };

    for (const model of [
      'example/model\u001b]0;sentinel\u0007',
      'example\nmodel',
    ]) {
      expect(() =>
        CredentialSchema.parse({
          ...labeled,
          labels: { ...labeled.labels, model },
        }),
      ).toThrow();
    }
  });

  test('rejects secret-bearing components in credential base URLs', () => {
    const credential = {
      model: 'example/model',
      harnesses: ['serf'],
    };

    for (const base_url of [
      'https://user:synthetic@example.test/v1',
      'https://@example.test/v1',
      'https:/@example.test/v1',
      String.raw`https:\@example.test/v1`,
      'https://example.test/v1?key=synthetic',
      'https://example.test/v1?',
      'https://example.test/v1#fragment',
      'https://example.test/v1#',
    ]) {
      expect(() =>
        CredentialSchema.parse({ ...credential, base_url }),
      ).toThrow();
    }
  });
});
