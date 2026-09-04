import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentRuntimeFamily,
  loadAgentConfigForValidation,
} from '../src/contracts/agent-config.ts';
import { loadCredentialsFile } from '../src/credentials/file.ts';
import {
  type AgentEnvProjection,
  CONVENTIONAL_API_KEY_ENV,
  credentialScopeForSelection,
  EMPTY_CREDENTIAL_SCOPE,
  type OAuthProjection,
} from '../src/credentials/scope.ts';
import { envSnapshot } from '../src/env.ts';
import { repoRoot } from '../src/paths.ts';

// These tests read the repo's committed corpus (credentials.yaml +
// coding-agents/*.yaml) — hermetic and deterministic. The delivery table below
// pins the closed contract for EVERY corpus-compatible agent/credential pair;
// a completeness test derives the pair set from the corpus itself, so adding
// an agent or credential without extending the table fails loudly instead of
// silently losing its projection.
//
// Corpus facts verified against credentials.yaml / coding-agents/*.yaml:
//   - Every claude api-key credential declares ANTHROPIC_API_KEY; the two
//     bedrock-bearer credentials declare AWS_BEARER_TOKEN_BEDROCK; opus5_sub
//     is auth oauth (Claude Code subscription token).
//   - kimi_k3 is the only api-key credential omitting api_key_env; the kimi
//     adapter reads KIMI_MODEL_API_KEY directly (conventional fallback).
//   - pi_default is oauth with provider pinned to openai-codex.
//   - The corpus has NO gemini oauth credential, no bedrock-bearer credential
//     without api_key_env, no pi oauth credential without provider, and no
//     (family, auth) pair outside the audited delivery map — those branches
//     are exercised against a synthetic evals-root fixture instead.

const root = repoRoot();
const codingAgentsDir = join(root, 'coding-agents');

function corpusAgents(): string[] {
  return readdirSync(codingAgentsDir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
}

describe('CONVENTIONAL_API_KEY_ENV', () => {
  test("freezes the adapters' current conventional api-key env contract", () => {
    // Mirrors the second argument each adapter passes resolveApiKey()
    // (src/agents/{index,serf,gemini,opencode,pi}.ts) plus kimi's direct
    // KIMI_MODEL_API_KEY read. Codex deliberately has no fallback
    // (resolveApiKey(credential, undefined)); hermes/copilot/antigravity have
    // none either (OAuth or provider-derived names). Mantle never uses this
    // map: bedrock-bearer requires an explicit api_key_env.
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

describe('EMPTY_CREDENTIAL_SCOPE', () => {
  test('is the asserted zero-material scope shape', () => {
    expect(EMPTY_CREDENTIAL_SCOPE).toEqual({
      schemaVersion: 1,
      kind: 'empty',
      agent: null,
      runtimeFamily: null,
      credential: null,
      agentEnv: [],
      geminiAuthType: null,
      oauth: null,
    });
  });
});

describe('agent-to-family mapping', () => {
  test('every corpus agent resolves to its reviewed runtime family', () => {
    // The delivery map keys on runtime family, not the agent alias; this pins
    // the full alias->family map so a future alias cannot silently miss its
    // conventional env or OAuth projector.
    const families = Object.fromEntries(
      corpusAgents().map((agent) => [
        agent,
        agentRuntimeFamily(
          loadAgentConfigForValidation(codingAgentsDir, agent),
        ),
      ]),
    );
    expect(families).toEqual({
      antigravity: 'antigravity',
      claude: 'claude',
      codex: 'codex',
      copilot: 'copilot',
      gemini: 'gemini',
      hermes: 'hermes',
      kimi: 'kimi',
      opencode: 'opencode',
      pi: 'pi',
      serf: 'serf',
    });
  });
});

// --- The full corpus delivery table -----------------------------------------

interface ExpectedDelivery {
  readonly agent: string;
  readonly family: string;
  readonly credential: string;
  readonly agentEnv: readonly AgentEnvProjection[];
  readonly geminiAuthType: 'gemini-api-key' | 'oauth-personal' | null;
  readonly oauth: OAuthProjection | null;
}

function keyEnv(name: string): readonly AgentEnvProjection[] {
  return [{ destinationName: name, sourceNames: [name] }];
}

// One passthrough env name, no mount: api-key, bedrock-bearer, and claude
// oauth deliveries all take this shape.
function envRow(
  agent: string,
  family: string,
  credential: string,
  envName: string,
): ExpectedDelivery {
  return {
    agent,
    family,
    credential,
    agentEnv: keyEnv(envName),
    geminiAuthType: null,
    oauth: null,
  };
}

function mountRow(
  agent: string,
  family: string,
  credential: string,
  oauth: OAuthProjection,
): ExpectedDelivery {
  return {
    agent,
    family,
    credential,
    agentEnv: [],
    geminiAuthType: null,
    oauth,
  };
}

const COPILOT_ENV: readonly AgentEnvProjection[] = [
  {
    destinationName: 'COPILOT_GITHUB_TOKEN',
    sourceNames: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  },
];

function copilotRow(credential: string): ExpectedDelivery {
  return {
    agent: 'copilot',
    family: 'copilot',
    credential,
    agentEnv: COPILOT_ENV,
    geminiAuthType: null,
    oauth: null,
  };
}

const DELIVERY_TABLE: readonly ExpectedDelivery[] = [
  // claude: explicit ANTHROPIC_API_KEY on every api-key record; Mantle rides
  // the declared bearer env; opus5_sub is the Claude Code OAuth token.
  envRow('claude', 'claude', 'opus', 'ANTHROPIC_API_KEY'),
  envRow('claude', 'claude', 'opus5', 'ANTHROPIC_API_KEY'),
  envRow('claude', 'claude', 'sonnet', 'ANTHROPIC_API_KEY'),
  envRow('claude', 'claude', 'sonnet5', 'ANTHROPIC_API_KEY'),
  envRow('claude', 'claude', 'sonnet46', 'ANTHROPIC_API_KEY'),
  envRow('claude', 'claude', 'haiku', 'ANTHROPIC_API_KEY'),
  envRow('claude', 'claude', 'opus_bedrock', 'AWS_BEARER_TOKEN_BEDROCK'),
  envRow('claude', 'claude', 'opus5_bedrock', 'AWS_BEARER_TOKEN_BEDROCK'),
  envRow('claude', 'claude', 'sonnet5_bedrock', 'AWS_BEARER_TOKEN_BEDROCK'),
  envRow('claude', 'claude', 'opus5_sub', 'CLAUDE_CODE_OAUTH_TOKEN'),
  // serf
  envRow('serf', 'serf', 'serf_default', 'ANTHROPIC_API_KEY'),
  // codex: subscription -> codex mount; api-key records all declare their env.
  mountRow('codex', 'codex', 'codex_sub', {
    kind: 'codex',
    mountName: 'codex',
  }),
  envRow('codex', 'codex', 'glm_5_2_responses', 'GLM_API_KEY'),
  envRow('codex', 'codex', 'openai_responses', 'OPENAI_API_KEY'),
  envRow('codex', 'codex', 'openai_responses_56sol', 'OPENAI_API_KEY'),
  envRow('codex', 'codex', 'openai_responses_56luna', 'OPENAI_API_KEY'),
  envRow('codex', 'codex', 'openai_responses_6astra', 'OPENAI_API_KEY'),
  // gemini: api-key mode is derived from credential.auth.
  {
    agent: 'gemini',
    family: 'gemini',
    credential: 'gemini_default',
    agentEnv: keyEnv('GEMINI_API_KEY'),
    geminiAuthType: 'gemini-api-key',
    oauth: null,
  },
  // antigravity rides the gemini mount (aliasing) under its own kind literal.
  mountRow('antigravity', 'antigravity', 'antigravity_default', {
    kind: 'antigravity',
    mountName: 'gemini',
  }),
  // kimi: oauth -> kimi mount; kimi_k3 omits api_key_env on purpose and falls
  // back to the conventional KIMI_MODEL_API_KEY.
  mountRow('kimi', 'kimi', 'kimi_default', { kind: 'kimi', mountName: 'kimi' }),
  envRow('kimi', 'kimi', 'kimi_k3', 'KIMI_MODEL_API_KEY'),
  // pi: oauth carries the pinned provider; api-key records declare their env.
  mountRow('pi', 'pi', 'pi_default', {
    kind: 'pi',
    mountName: 'pi',
    provider: 'openai-codex',
  }),
  envRow('pi', 'pi', 'pi_gpt56_sol', 'OPENAI_API_KEY'),
  envRow('pi', 'pi', 'openrouter_glm_5_2', 'OPENROUTER_API_KEY'),
  envRow('pi', 'pi', 'openrouter_kimi_k27_code', 'OPENROUTER_API_KEY'),
  envRow('pi', 'pi', 'glm_5_2_chat', 'GLM_API_KEY'),
  envRow('pi', 'pi', 'ollama_local', 'OLLAMA_API_KEY'),
  // opencode
  envRow('opencode', 'opencode', 'opencode_gpt5', 'OPENAI_API_KEY'),
  envRow('opencode', 'opencode', 'opencode_gpt56_sol', 'OPENAI_API_KEY'),
  envRow('opencode', 'opencode', 'openrouter_glm_5_2', 'OPENROUTER_API_KEY'),
  envRow(
    'opencode',
    'opencode',
    'openrouter_kimi_k27_code',
    'OPENROUTER_API_KEY',
  ),
  envRow('opencode', 'opencode', 'glm_5_2_chat', 'GLM_API_KEY'),
  envRow('opencode', 'opencode', 'ollama_local', 'OLLAMA_API_KEY'),
  // hermes: every corpus credential declares api_key_env (no conventional).
  envRow('hermes', 'hermes', 'openrouter_glm_5_2', 'OPENROUTER_API_KEY'),
  envRow('hermes', 'hermes', 'openrouter_hermes4', 'OPENROUTER_API_KEY'),
  // copilot: ordered GitHub token sources into one destination.
  copilotRow('copilot_default'),
  copilotRow('copilot_gpt56_sol'),
  copilotRow('copilot_gpt56_luna'),
  copilotRow('copilot_opus5'),
  copilotRow('copilot_mai_flash'),
];

describe('credentialScopeForSelection: corpus pairs', () => {
  test('the delivery table covers exactly the corpus-compatible pairs', () => {
    const registry = loadCredentialsFile(
      join(root, 'credentials.yaml'),
    ).credentials;
    const compatible: string[] = [];
    for (const agent of corpusAgents()) {
      const family = agentRuntimeFamily(
        loadAgentConfigForValidation(codingAgentsDir, agent),
      );
      for (const [name, entry] of Object.entries(registry)) {
        if (entry.harnesses.includes(family)) {
          compatible.push(`${agent} × ${name}`);
        }
      }
    }
    const tabled = DELIVERY_TABLE.map((r) => `${r.agent} × ${r.credential}`);
    expect(new Set(tabled).size).toBe(tabled.length);
    expect([...tabled].sort()).toEqual([...compatible].sort());
  });

  for (const row of DELIVERY_TABLE) {
    test(`${row.agent} × ${row.credential}`, () => {
      expect(
        credentialScopeForSelection(root, {
          agent: row.agent,
          credential: row.credential,
        }),
      ).toEqual({
        schemaVersion: 1,
        kind: 'live',
        agent: row.agent,
        runtimeFamily: row.family,
        credential: row.credential,
        agentEnv: row.agentEnv,
        geminiAuthType: row.geminiAuthType,
        oauth: row.oauth,
      });
    });
  }
});

describe('brief-pinned projections', () => {
  test('copilot ordered token sources into COPILOT_GITHUB_TOKEN', () => {
    expect(
      credentialScopeForSelection(root, {
        agent: 'copilot',
        credential: 'copilot_default',
      }).agentEnv,
    ).toEqual([
      {
        destinationName: 'COPILOT_GITHUB_TOKEN',
        sourceNames: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
      },
    ]);
  });

  test('claude oauth projects CLAUDE_CODE_OAUTH_TOKEN from the same name', () => {
    expect(
      credentialScopeForSelection(root, {
        agent: 'claude',
        credential: 'opus5_sub',
      }).agentEnv,
    ).toEqual([
      {
        destinationName: 'CLAUDE_CODE_OAUTH_TOKEN',
        sourceNames: ['CLAUDE_CODE_OAUTH_TOKEN'],
      },
    ]);
  });

  test('gemini mode derives from credential.auth, ignoring ambient GEMINI_AUTH_TYPE', () => {
    // The gemini launcher's ambient GEMINI_AUTH_TYPE env must not leak into
    // the scope: an ambient oauth-personal while the selected credential is
    // api-key stays gemini-api-key. The hostile ambient value lives in a child
    // process's env, so the parent env is never mutated — no later test or
    // subprocess can see a GEMINI_AUTH_TYPE this test invented.
    const hadKey = Object.hasOwn(envSnapshot(), 'GEMINI_AUTH_TYPE');
    const before = envSnapshot()['GEMINI_AUTH_TYPE'];
    const script = [
      `const { credentialScopeForSelection } = await import(${JSON.stringify(
        join(root, 'src/credentials/scope.ts'),
      )});`,
      `const scope = credentialScopeForSelection(${JSON.stringify(root)}, {`,
      "  agent: 'gemini',",
      "  credential: 'gemini_default',",
      '});',
      'process.stdout.write(String(scope.geminiAuthType));',
    ].join('\n');
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...envSnapshot(), GEMINI_AUTH_TYPE: 'oauth-personal' },
    });
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('gemini-api-key');
    // Exact parent-env preservation: key presence AND value are unchanged.
    expect(Object.hasOwn(envSnapshot(), 'GEMINI_AUTH_TYPE')).toBe(hadKey);
    expect(envSnapshot()['GEMINI_AUTH_TYPE']).toBe(before);
  });
});

describe('default resolution', () => {
  const AGENT_DEFAULTS: Readonly<Record<string, string>> = {
    antigravity: 'antigravity_default',
    claude: 'opus_bedrock',
    codex: 'codex_sub',
    copilot: 'copilot_default',
    gemini: 'gemini_default',
    hermes: 'openrouter_glm_5_2',
    kimi: 'kimi_default',
    opencode: 'opencode_gpt5',
    pi: 'pi_default',
    serf: 'serf_default',
  };

  test('the defaults table covers every corpus agent', () => {
    expect(Object.keys(AGENT_DEFAULTS).sort()).toEqual(corpusAgents());
  });

  for (const [agent, credential] of Object.entries(AGENT_DEFAULTS)) {
    test(`${agent} default persists concrete credential '${credential}'`, () => {
      const scope = credentialScopeForSelection(root, {
        agent,
        credential: null,
      });
      expect(scope.credential).toBe(credential);
      expect(scope).toEqual(
        credentialScopeForSelection(root, { agent, credential }),
      );
    });
  }
});

describe('named credential-scope errors', () => {
  test('incompatible agent/credential pair fails closed naming both', () => {
    expect(() =>
      credentialScopeForSelection(root, {
        agent: 'claude',
        credential: 'codex_sub',
      }),
    ).toThrow(/credential 'codex_sub'.*not compatible.*agent 'claude'/);
  });

  test('unknown agent throws an error naming the agent', () => {
    expect(() =>
      credentialScopeForSelection(root, {
        agent: 'nosuchagent',
        credential: null,
      }),
    ).toThrow(/unknown coding agent 'nosuchagent'/);
    expect(() =>
      credentialScopeForSelection(root, {
        agent: 'nosuchagent',
        credential: 'codex_sub',
      }),
    ).toThrow(/unknown coding agent 'nosuchagent'/);
  });

  test('unknown credential throws an error naming the credential', () => {
    expect(() =>
      credentialScopeForSelection(root, {
        agent: 'codex',
        credential: 'nosuchcred',
      }),
    ).toThrow(/unknown credential 'nosuchcred'/);
  });

  test('Object.prototype property names are unknown credentials, not TypeErrors', () => {
    // `in` and bare [] both see inherited properties: registry['constructor']
    // is the Object constructor and registry['__proto__'] is Object.prototype,
    // neither of which has .harnesses — an inherited-property read surfaces
    // as "TypeError: undefined is not an object (entry.harnesses.includes)"
    // instead of the named unknown-credential error. Both must fail closed
    // with the required named error.
    expect(() =>
      credentialScopeForSelection(root, {
        agent: 'codex',
        credential: 'constructor',
      }),
    ).toThrow(/unknown credential 'constructor'/);
    expect(() =>
      credentialScopeForSelection(root, {
        agent: 'codex',
        credential: '__proto__',
      }),
    ).toThrow(/unknown credential '__proto__'/);
  });

  test('Object.prototype property names are unknown agents', () => {
    expect(() =>
      credentialScopeForSelection(root, {
        agent: 'constructor',
        credential: null,
      }),
    ).toThrow(/unknown coding agent 'constructor'/);
    expect(() =>
      credentialScopeForSelection(root, {
        agent: '__proto__',
        credential: null,
      }),
    ).toThrow(/unknown coding agent '__proto__'/);
  });
});

// --- Synthetic evals-root fixture --------------------------------------------
// The committed corpus cannot reach these audited branches: it has no gemini
// oauth credential, no bedrock-bearer credential without api_key_env, no pi
// oauth credential without provider, no (family, auth) pair outside the
// delivery map, no api-key credential without api_key_env on a family lacking
// a conventional name, and no agent without default_credential. One synthetic
// root covers exactly those brief-mandated branches — no committed-corpus
// change, no speculative behavior.

function syntheticAgentYaml(
  name: string,
  extra: readonly string[] = [],
): string {
  // Minimal AgentConfigSchema-valid config. loadAgentConfigForValidation
  // checks neither required_env nor binaries, so this stays hermetic.
  return [
    `name: ${name}`,
    `binary: ${name}`,
    'home_config_subdir: "."',
    'session_log_dir: logs',
    'session_log_glob: "*.jsonl"',
    `normalizer: ${name}`,
    ...extra,
    '',
  ].join('\n');
}

const synthRoot = mkdtempSync(join(tmpdir(), 'credential-scope-synthetic-'));
afterAll(() => rmSync(synthRoot, { recursive: true, force: true }));
mkdirSync(join(synthRoot, 'coding-agents'));
for (const [file, content] of [
  ['gemini.yaml', syntheticAgentYaml('gemini')],
  // claude family requires default_credential at validation time.
  [
    'claude.yaml',
    syntheticAgentYaml('claude', ['default_credential: mantle_no_env']),
  ],
  ['pi.yaml', syntheticAgentYaml('pi')],
  ['codex.yaml', syntheticAgentYaml('codex')],
  ['opencode.yaml', syntheticAgentYaml('opencode')],
] as const) {
  writeFileSync(join(synthRoot, 'coding-agents', file), content);
}
writeFileSync(
  join(synthRoot, 'credentials.yaml'),
  [
    'gemini_oauth:',
    '  model: gemini-2.5-pro',
    '  api: gemini',
    '  auth: oauth',
    '  harnesses: [gemini]',
    'mantle_no_env:',
    '  model: anthropic.claude-opus-5',
    '  api: mantle',
    '  auth: bedrock-bearer',
    '  region: us-east-1',
    '  harnesses: [claude]',
    'pi_oauth_no_provider:',
    '  model: gpt-5.5',
    '  auth: oauth',
    '  harnesses: [pi]',
    'gemini_sub:',
    '  model: gemini-2.5-pro',
    '  api: gemini',
    '  auth: subscription',
    '  harnesses: [gemini]',
    'codex_key_no_env:',
    '  model: gpt-5.5',
    '  api: openai-responses',
    '  harnesses: [codex]',
    '',
  ].join('\n'),
);

describe('synthetic evals-root branches', () => {
  test('gemini oauth delivers the gemini mount and oauth-personal mode', () => {
    expect(
      credentialScopeForSelection(synthRoot, {
        agent: 'gemini',
        credential: 'gemini_oauth',
      }),
    ).toEqual({
      schemaVersion: 1,
      kind: 'live',
      agent: 'gemini',
      runtimeFamily: 'gemini',
      credential: 'gemini_oauth',
      agentEnv: [],
      geminiAuthType: 'oauth-personal',
      oauth: { kind: 'gemini', mountName: 'gemini' },
    });
  });

  test('bedrock-bearer without api_key_env fails closed (no conventional fallback)', () => {
    expect(() =>
      credentialScopeForSelection(synthRoot, {
        agent: 'claude',
        credential: 'mantle_no_env',
      }),
    ).toThrow(/bedrock-bearer credential 'mantle_no_env'.*api_key_env/);
  });

  test('pi oauth without provider fails closed naming the credential', () => {
    expect(() =>
      credentialScopeForSelection(synthRoot, {
        agent: 'pi',
        credential: 'pi_oauth_no_provider',
      }),
    ).toThrow(/pi oauth credential 'pi_oauth_no_provider'.*provider/);
  });

  test('a pair without an audited delivery channel fails closed', () => {
    expect(() =>
      credentialScopeForSelection(synthRoot, {
        agent: 'gemini',
        credential: 'gemini_sub',
      }),
    ).toThrow(
      /no audited delivery channel for family 'gemini' auth 'subscription'/,
    );
  });

  test('api-key credential without api_key_env on a family with no conventional name fails closed', () => {
    expect(() =>
      credentialScopeForSelection(synthRoot, {
        agent: 'codex',
        credential: 'codex_key_no_env',
      }),
    ).toThrow(/api-key credential 'codex_key_no_env'.*conventional/);
  });

  test('null selection with no default_credential fails closed naming the agent', () => {
    expect(() =>
      credentialScopeForSelection(synthRoot, {
        agent: 'opencode',
        credential: null,
      }),
    ).toThrow(/agent 'opencode'.*default_credential/);
  });
});
