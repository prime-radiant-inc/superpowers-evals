import { describe, expect, test } from 'bun:test';
import {
  AGENT_OAUTH_MOUNT,
  CONVENTIONAL_API_KEY_ENV,
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
//
// Pre-review correction facts (verified against current source):
//   - kimi_k3 is auth api-key with NO api_key_env; credentials.yaml and
//     src/agents/kimi.ts document KIMI_MODEL_API_KEY as the env the api-key
//     path actually reads, so it is NOT zero-material.
//   - The per-family conventional api-key env names mirror what each adapter
//     passes to resolveApiKey(credential, <conventional>): claude/serf
//     ANTHROPIC_API_KEY, gemini GEMINI_API_KEY, opencode OPENAI_API_KEY, pi
//     PI_API_KEY; codex passes undefined (no fallback); kimi reads
//     KIMI_MODEL_API_KEY directly. Hermes derives a provider-specific name and
//     every hermes-corpus credential declares api_key_env; copilot/antigravity
//     are OAuth paths.

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

describe('CONVENTIONAL_API_KEY_ENV', () => {
  test("freezes the adapters' current conventional api-key env contract", () => {
    // Mirrors the second argument each adapter passes resolveApiKey() today
    // (src/agents/{index,serf,gemini,opencode,pi}.ts) plus kimi's direct
    // KIMI_MODEL_API_KEY read. Codex deliberately has no fallback
    // (resolveApiKey(credential, undefined)); hermes/copilot/antigravity have
    // none either (OAuth or provider-derived names).
    expect(CONVENTIONAL_API_KEY_ENV).toEqual({
      claude: 'ANTHROPIC_API_KEY',
      serf: 'ANTHROPIC_API_KEY',
      gemini: 'GEMINI_API_KEY',
      kimi: 'KIMI_MODEL_API_KEY',
      opencode: 'OPENAI_API_KEY',
      pi: 'PI_API_KEY',
    });
    expect(CONVENTIONAL_API_KEY_ENV['codex']).toBeUndefined();
    expect(CONVENTIONAL_API_KEY_ENV['hermes']).toBeUndefined();
    expect(CONVENTIONAL_API_KEY_ENV['copilot']).toBeUndefined();
    expect(CONVENTIONAL_API_KEY_ENV['antigravity']).toBeUndefined();
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
    // The legitimate zero-material shape: oauth auth with no api_key_env and
    // no bundle mount entry (copilot's GitHub auth is seeded by the adapter,
    // not by the bundle). Contrast kimi_k3 above, which is api-key and
    // therefore needs KIMI_MODEL_API_KEY.
    //
    // The fail-closed case (api-key credential with no api_key_env whose
    // family has no conventional name, e.g. a hypothetical codex api-key
    // credential without api_key_env) is unreachable with the committed
    // corpus: a registry scan shows kimi_k3 is the only api-key credential
    // omitting api_key_env, and kimi has a conventional name. Testing it
    // would require an injection hook or a corpus edit — declined.
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

  test('api-key credential without api_key_env falls back to the conventional env name', () => {
    // kimi_k3 declares no api_key_env (a registry scan confirms it is the only
    // such api-key credential); the kimi adapter reads KIMI_MODEL_API_KEY, so
    // the scope must carry that name — it is NOT zero-material.
    const scope = credentialScopeForAgents(['kimi'], ['kimi_k3']);
    expect(scope.envNames).toEqual(['KIMI_MODEL_API_KEY']);
    expect(scope.authMounts).toEqual([]);
  });

  test('explicit api_key_env overrides the conventional name', () => {
    // pi_gpt56_sol rides pi's api-key path but declares OPENAI_API_KEY; the
    // scope must carry the declared name, not pi's conventional PI_API_KEY.
    const scope = credentialScopeForAgents(['pi'], ['pi_gpt56_sol']);
    expect(scope.envNames).toEqual(['OPENAI_API_KEY']);
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
