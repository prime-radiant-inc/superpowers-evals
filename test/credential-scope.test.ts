import { describe, expect, test } from 'bun:test';
import {
  AGENT_OAUTH_MOUNT,
  credentialScopeForAgents,
} from '../src/credentials/scope.ts';

// These tests read the repo's committed corpus (credentials.yaml +
// coding-agents/*.yaml) — hermetic and deterministic. Concrete facts asserted
// below were verified against that corpus:
//   - codex default_credential: codex_sub (auth: subscription, no api_key_env)
//   - claude default_credential: opus_bedrock (auth: bedrock-bearer,
//     api_key_env: AWS_BEARER_TOKEN_BEDROCK)
//   - antigravity default_credential: antigravity_default (auth: oauth)
//   - copilot default_credential: copilot_default (auth: oauth, no mount entry)
//   - openai_responses_56sol / openrouter_glm_5_2 / opus / opus5 / kimi_k3 as
//     documented in credentials.yaml.

describe('AGENT_OAUTH_MOUNT', () => {
  test('maps each OAuth-capable harness to its bundle mount dir', () => {
    expect(AGENT_OAUTH_MOUNT).toEqual({
      codex: 'codex',
      gemini: 'gemini',
      antigravity: 'gemini',
      kimi: 'kimi',
      pi: 'pi',
    });
  });
  test('claude and copilot have no OAuth mount entry', () => {
    expect(AGENT_OAUTH_MOUNT['claude']).toBeUndefined();
    expect(AGENT_OAUTH_MOUNT['copilot']).toBeUndefined();
  });
});

describe('credentialScopeForAgents', () => {
  test('explicit api-key credential contributes its env name only', () => {
    // openai_responses_56sol: auth api-key (default), api_key_env
    // OPENAI_API_KEY, harnesses [codex].
    const scope = credentialScopeForAgents(
      ['codex'],
      ['openai_responses_56sol'],
    );
    expect(scope.envNames).toEqual(['OPENAI_API_KEY']);
    expect(scope.authMounts).toEqual([]);
  });

  test('explicit subscription credential contributes its OAuth mount only', () => {
    // codex_sub: auth subscription, no api_key_env.
    const scope = credentialScopeForAgents(['codex'], ['codex_sub']);
    expect(scope.envNames).toEqual([]);
    expect(scope.authMounts).toEqual(['codex']);
  });

  test('default credentials per agent: claude env-only, codex mount', () => {
    // claude defaults to opus_bedrock (bedrock-bearer env key, no mount);
    // codex defaults to codex_sub (subscription -> codex mount).
    const scope = credentialScopeForAgents(['claude', 'codex'], null);
    expect(scope.envNames).toEqual(['AWS_BEARER_TOKEN_BEDROCK']);
    expect(scope.authMounts).toEqual(['codex']);
  });

  test('antigravity default rides the gemini mount (aliasing)', () => {
    const scope = credentialScopeForAgents(['antigravity'], null);
    expect(scope.envNames).toEqual([]);
    expect(scope.authMounts).toEqual(['gemini']);
  });

  test('copilot default is a valid zero-material default scope', () => {
    // copilot_default is oauth but copilot has no AGENT_OAUTH_MOUNT entry and
    // the credential has no api_key_env: the defaults path may legitimately
    // produce an empty (unscoped/legacy) scope.
    const scope = credentialScopeForAgents(['copilot'], null);
    expect(scope).toEqual({ envNames: [], authMounts: [] });
  });

  test('unions and dedupes env names across a multi-credential selection', () => {
    // opus and opus5 are both anthropic api-key creds for the claude family:
    // same ANTHROPIC_API_KEY env name, deduped to one entry.
    const scope = credentialScopeForAgents(['claude'], ['opus', 'opus5']);
    expect(scope.envNames).toEqual(['ANTHROPIC_API_KEY']);
  });

  test('one credential shared by several compatible agents', () => {
    // openrouter_glm_5_2 harnesses [pi, opencode, hermes]: compatible with
    // both pi and opencode; api-key auth, so no mounts despite pi having a
    // mount entry.
    const scope = credentialScopeForAgents(
      ['pi', 'opencode'],
      ['openrouter_glm_5_2'],
    );
    expect(scope.envNames).toEqual(['OPENROUTER_API_KEY']);
    expect(scope.authMounts).toEqual([]);
  });

  test('incompatible agent/credential pairs are filtered, not errors', () => {
    // codex_sub harnesses [codex] only: the (claude, codex_sub) pair is
    // skipped exactly like run-all matrix eligibility; the compatible codex
    // pair still contributes.
    const scope = credentialScopeForAgents(['claude', 'codex'], ['codex_sub']);
    expect(scope.envNames).toEqual([]);
    expect(scope.authMounts).toEqual(['codex']);
  });

  test('zero compatible pairs in an asserted selection fails closed', () => {
    expect(() => credentialScopeForAgents(['claude'], ['codex_sub'])).toThrow(
      /claude.*codex_sub|codex_sub.*claude/,
    );
  });

  test('valid zero-material selection returns an asserted empty scope', () => {
    // kimi_k3 is api-key with no api_key_env: a compatible pair that needs
    // neither an env var nor a mount. Valid (no throw), and distinct from the
    // zero-pairs fail-closed case above.
    const scope = credentialScopeForAgents(['kimi'], ['kimi_k3']);
    expect(scope).toEqual({ envNames: [], authMounts: [] });
  });

  test('empty agent list means unscoped (legacy full bundle)', () => {
    expect(credentialScopeForAgents([], null)).toEqual({
      envNames: [],
      authMounts: [],
    });
    expect(credentialScopeForAgents([], ['codex_sub'])).toEqual({
      envNames: [],
      authMounts: [],
    });
  });

  test('unknown agent throws an error naming the agent', () => {
    expect(() => credentialScopeForAgents(['nosuchagent'], null)).toThrow(
      /nosuchagent/,
    );
    expect(() =>
      credentialScopeForAgents(['nosuchagent'], ['codex_sub']),
    ).toThrow(/nosuchagent/);
  });

  test('unknown credential throws an error naming the credential', () => {
    expect(() => credentialScopeForAgents(['codex'], ['nosuchcred'])).toThrow(
      /nosuchcred/,
    );
  });
});
