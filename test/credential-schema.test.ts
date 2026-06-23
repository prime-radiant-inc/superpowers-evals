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
  test('parseCredentialsFile enforces name charset', () => {
    expect(() =>
      parseCredentialsFile({ 'bad-name': { model: 'm', harnesses: ['pi'] } }),
    ).toThrow(/[a-z0-9_]/);
  });
});
