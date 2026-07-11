import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { shellSingleQuote } from '../src/agents/index.ts';
import type { AtifTrajectory } from '../src/atif/types.ts';
import type { Credential } from '../src/contracts/credential.ts';
import { resolveCredentialNameForAgent } from '../src/credentials/index.ts';
import { allocateRunDir, runScenario } from '../src/runner/index.ts';

const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

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

test('direct external Serf campaign rejects missing route labels before run allocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'campaign-preflight-'));
  const outRoot = join(root, 'results');
  const credentialsPath = join(root, 'campaign.yaml');
  mkdirSync(outRoot);
  writeFileSync(
    credentialsPath,
    [
      'candidate:',
      '  model: openrouter/@preset/example-a',
      '  harnesses: [serf]',
      '  api: openai-chat',
      '  base_url: https://openrouter.ai/api/v1',
      '  api_key_env: OPENROUTER_API_KEY',
      '',
    ].join('\n'),
  );

  await expect(
    runScenario({
      scenarioDir: join(root, 'scenario'),
      codingAgent: 'serf-alias',
      codingAgentsDir: join(root, 'coding-agents'),
      outRoot,
      credential: 'candidate',
      credentialsPath,
      credentialsOrigin: 'external-campaign',
    }),
  ).rejects.toThrow(/route-attestation labels/);
  expect(readdirSync(outRoot)).toEqual([]);
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

function makeSerfScenario(root: string): string {
  const scenario = join(root, 'scenario');
  mkdirSync(scenario, { recursive: true });
  writeFileSync(
    join(scenario, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nExercise Serf context substitution.\n',
  );
  const setup = join(scenario, 'setup.sh');
  writeFileSync(setup, '#!/usr/bin/env bash\n:\n');
  chmodSync(setup, 0o755);
  writeFileSync(join(scenario, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return scenario;
}

function makeSerfSuperpowersRoot(root: string): string {
  const superpowersRoot = join(root, 'superpowers');
  for (const path of [
    '.claude-plugin/plugin.json',
    'hooks/hooks.json',
    'hooks/run-hook.cmd',
    'hooks/session-start',
    'skills/using-superpowers/SKILL.md',
    'skills/brainstorming/SKILL.md',
  ]) {
    const destination = join(superpowersRoot, path);
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, '{}\n');
  }
  return superpowersRoot;
}

function writeSerfCredentialFixture(path: string, presetModel: string): void {
  writeFileSync(
    path,
    [
      'serf_default:',
      '  model: anthropic/claude-sonnet-4-6',
      '  harnesses: [serf]',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: ANTHROPIC_API_KEY',
      'serf_campaign:',
      `  model: ${presetModel}`,
      '  harnesses: [serf]',
      '  api: openai-chat',
      '  auth: api-key',
      '  api_key_env: OPENROUTER_API_KEY',
      '',
    ].join('\n'),
  );
}

async function generateSerfContext(credential: string | undefined): Promise<{
  readonly context: string;
  readonly presetModel: string;
  readonly secret: string;
  readonly defaultSecret: string;
}> {
  const root = mkdtempSync(join(tmpdir(), 'runner-serf-context-'));
  const bin = join(root, 'bin');
  const credentialsPath = join(root, 'credentials.yaml');
  const presetModel = 'openrouter/@preset/example-version';
  const secret = crypto.randomUUID();
  const defaultSecret = crypto.randomUUID();
  const previousPath = Bun.env['PATH'];
  const previousRoot = Bun.env['SUPERPOWERS_ROOT'];
  const previousOpenRouter = Bun.env['OPENROUTER_API_KEY'];
  const previousAnthropic = Bun.env['ANTHROPIC_API_KEY'];

  mkdirSync(bin, { recursive: true });
  for (const binary of ['serf', 'gauntlet']) {
    const path = join(bin, binary);
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
  }
  writeSerfCredentialFixture(credentialsPath, presetModel);

  Bun.env['PATH'] = `${bin}:${previousPath ?? ''}`;
  Bun.env['SUPERPOWERS_ROOT'] = makeSerfSuperpowersRoot(root);
  Bun.env['OPENROUTER_API_KEY'] = secret;
  // The default Serf credential selects this key. Named campaign coverage below
  // proves that this dynamically generated, non-selected value is never baked.
  Bun.env['ANTHROPIC_API_KEY'] = defaultSecret;

  try {
    const { runDir } = await runScenario({
      scenarioDir: makeSerfScenario(root),
      codingAgent: 'serf',
      codingAgentsDir: REAL_CODING_AGENTS,
      outRoot: join(root, 'results'),
      credential,
      credentialsPath,
    });
    return {
      context: readFileSync(
        join(runDir, 'gauntlet-agent', 'context', 'launch-agent'),
        'utf8',
      ),
      presetModel,
      secret,
      defaultSecret,
    };
  } finally {
    if (previousPath === undefined) delete Bun.env['PATH'];
    else Bun.env['PATH'] = previousPath;
    if (previousRoot === undefined) delete Bun.env['SUPERPOWERS_ROOT'];
    else Bun.env['SUPERPOWERS_ROOT'] = previousRoot;
    if (previousOpenRouter === undefined) {
      delete Bun.env['OPENROUTER_API_KEY'];
    } else {
      Bun.env['OPENROUTER_API_KEY'] = previousOpenRouter;
    }
    if (previousAnthropic === undefined) {
      delete Bun.env['ANTHROPIC_API_KEY'];
    } else {
      Bun.env['ANTHROPIC_API_KEY'] = previousAnthropic;
    }
  }
}

describe.serial('Serf credential runner integration', () => {
  test('Serf context uses the named credential preset model and selected key name without its value', async () => {
    const { context, presetModel, secret, defaultSecret } =
      await generateSerfContext('serf_campaign');

    expect(context).toContain(`--model ${shellSingleQuote(presetModel)}`);
    expect(context).not.toContain('anthropic/claude-sonnet-4-6');
    expect(context).toContain('OPENROUTER_API_KEY');
    expect(context).not.toContain(secret);
    expect(context).not.toContain(defaultSecret);
  }, 10_000);

  test('Serf context defaults its selected API-key environment name to ANTHROPIC_API_KEY', async () => {
    const { context, defaultSecret } = await generateSerfContext(undefined);
    expect(context).toContain('ANTHROPIC_API_KEY');
    expect(context).not.toContain(defaultSecret);
  }, 10_000);

  test('runScenario writes a run-local credential snapshot without environment secret values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runner-credential-snapshot-'));
    const agents = join(root, 'coding-agents');
    const sourcePath = join(root, 'credentials.yaml');
    const secret = crypto.randomUUID();
    const previous = Bun.env['OPENROUTER_API_KEY'];

    mkdirSync(agents, { recursive: true });
    writeFileSync(
      join(agents, 'pi.yaml'),
      `${[
        'name: pi',
        'binary: pi',
        'session_log_dir: ~/.pi/sessions',
        'session_log_glob: "*.jsonl"',
        'normalizer: pi',
        'home_config_subdir: .pi',
      ].join('\n')}\n`,
    );
    writeFileSync(
      sourcePath,
      [
        'campaign:',
        '  model: example-model',
        '  harnesses: [pi]',
        '  api: openai-chat',
        '  base_url: https://example.invalid/v1',
        '  auth: api-key',
        '  api_key_env: OPENROUTER_API_KEY',
        '',
      ].join('\n'),
    );
    Bun.env['OPENROUTER_API_KEY'] = secret;

    try {
      const { runDir } = await runScenario({
        scenarioDir: join(root, 'missing-scenario'),
        codingAgent: 'pi',
        codingAgentsDir: agents,
        outRoot: join(root, 'results'),
        credential: 'campaign',
        credentialsPath: sourcePath,
      });
      const snapshot = readFileSync(
        join(runDir, 'credentials.snapshot.yaml'),
        'utf8',
      );

      expect(snapshot).toContain('model: example-model');
      expect(snapshot).toContain('OPENROUTER_API_KEY');
      expect(snapshot).not.toContain(secret);
    } finally {
      if (previous === undefined) {
        delete Bun.env['OPENROUTER_API_KEY'];
      } else {
        Bun.env['OPENROUTER_API_KEY'] = previous;
      }
    }
  });

  // --- OpenRouter generation attestation after generic Serf capture ---

  const OPENROUTER_LABELS = {
    model: 'example/model-a',
    provider: 'example-provider',
    quantization: 'fp8',
    preset_id: '00000000-0000-4000-8000-000000000004',
    preset_version_id: '00000000-0000-4000-8000-000000000005',
    is_byok: false,
    catalog_as_of: '2026-07-10',
  } as const;
  const ATTESTATION_TRANSCRIPT = 'transcript-content-must-not-persist';

  function attestationTrajectory(
    responseIds: readonly string[],
    withUsage = true,
  ): AtifTrajectory {
    const ids =
      responseIds.length === 0 ? ['not-an-openrouter-id'] : responseIds;
    return {
      schema_version: 'ATIF-v1.7',
      agent: {
        name: 'serf',
        version: 'test',
        model_name: OPENROUTER_LABELS.model,
      },
      steps: ids.map((responseId, index) => ({
        step_id: index + 1,
        source: 'agent',
        message: ATTESTATION_TRANSCRIPT,
        tool_calls: [
          {
            tool_call_id: `call-${index + 1}`,
            function_name: 'read_file',
            arguments: { file_path: 'README.md' },
          },
        ],
        ...(withUsage
          ? {
              metrics: {
                prompt_tokens: 100,
                completion_tokens: 20,
                cached_tokens: 5,
              },
            }
          : {}),
        extra: { response_id: responseId },
      })),
    };
  }

  function writeAttestationCredentials(path: string): void {
    const labels = [
      '  labels:',
      `    model: ${OPENROUTER_LABELS.model}`,
      `    provider: ${OPENROUTER_LABELS.provider}`,
      `    quantization: ${OPENROUTER_LABELS.quantization}`,
      `    preset_id: ${OPENROUTER_LABELS.preset_id}`,
      `    preset_version_id: ${OPENROUTER_LABELS.preset_version_id}`,
      `    is_byok: ${OPENROUTER_LABELS.is_byok}`,
      `    catalog_as_of: ${OPENROUTER_LABELS.catalog_as_of}`,
    ];
    writeFileSync(
      path,
      [
        'campaign:',
        '  model: openrouter/@preset/example-a',
        '  harnesses: [serf]',
        '  api: openai-chat',
        '  base_url: https://openrouter.ai/api/v1',
        '  auth: api-key',
        '  api_key_env: OPENROUTER_API_KEY',
        ...labels,
        'unlabeled:',
        '  model: openrouter/@preset/example-a',
        '  harnesses: [serf]',
        '  api: openai-chat',
        '  base_url: https://openrouter.ai/api/v1',
        '  auth: api-key',
        '  api_key_env: OPENROUTER_API_KEY',
        'other_endpoint:',
        '  model: openrouter/@preset/example-a',
        '  harnesses: [serf]',
        '  api: openai-chat',
        '  base_url: https://example.invalid/v1',
        '  auth: api-key',
        '  api_key_env: OPENROUTER_API_KEY',
        ...labels,
        '',
      ].join('\n'),
    );
  }

  function makeAttestationScenario(root: string, postMarker: string): string {
    const scenario = join(root, 'scenario');
    mkdirSync(scenario, { recursive: true });
    writeFileSync(join(scenario, 'story.md'), 'Attestation runner test.\n');
    const setup = join(scenario, 'setup.sh');
    writeFileSync(setup, '#!/usr/bin/env bash\n:\n');
    chmodSync(setup, 0o755);
    writeFileSync(
      join(scenario, 'checks.sh'),
      `pre() { :; }\npost() { printf post > ${shellSingleQuote(postMarker)}; }\n`,
    );
    return scenario;
  }

  function writeFakeSerfGauntlet(
    binDir: string,
    trajectory: AtifTrajectory,
  ): void {
    const gauntlet = join(binDir, 'gauntlet');
    const serf = join(binDir, 'serf');
    writeFileSync(
      gauntlet,
      `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = Bun.argv.slice(2);
const projectIndex = args.indexOf('--project-dir');
const runDir = projectIndex < 0 ? undefined : args[projectIndex + 1];
const home = Bun.env['QUORUM_AGENT_HOME'];
if (runDir === undefined || home === undefined) process.exit(2);
const results = join(runDir, 'gauntlet-agent', 'results', 'fake');
mkdirSync(results, { recursive: true });
writeFileSync(join(results, 'result.json'), JSON.stringify({ status: 'pass' }));
const exportsDir = join(home, '.serf', 'exports');
mkdirSync(exportsDir, { recursive: true });
writeFileSync(join(exportsDir, 'trajectory.json'), ${JSON.stringify(
        JSON.stringify(trajectory),
      )});
`,
    );
    chmodSync(gauntlet, 0o755);
    writeFileSync(serf, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(serf, 0o755);
  }

  function generationPayload(
    id: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      data: {
        id,
        model: OPENROUTER_LABELS.model,
        provider_name: 'Example Provider',
        preset_id: OPENROUTER_LABELS.preset_id,
        is_byok: OPENROUTER_LABELS.is_byok,
        latency: 1,
        generation_time: 1,
        native_tokens_prompt: 100,
        native_tokens_completion: 20,
        native_tokens_reasoning: 0,
        native_tokens_cached: 5,
        total_cost: 0.0125,
        upstream_inference_cost: 0.01,
        prompt: ATTESTATION_TRANSCRIPT,
        completion: ATTESTATION_TRANSCRIPT,
        ...overrides,
      },
    };
  }

  interface AttestationRunOptions {
    readonly credential?: 'campaign' | 'unlabeled' | 'other_endpoint';
    readonly responseIds?: readonly string[];
    readonly withUsage?: boolean;
    readonly openRouterFetch?: typeof fetch;
    readonly openRouterAttestationWriter?: () => void;
  }

  function injectedFetch(
    fn: (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => Promise<Response>,
  ): typeof fetch {
    return Object.assign(fn, { preconnect: fetch.preconnect });
  }

  async function runAttestationScenario(
    options: AttestationRunOptions = {},
  ): Promise<{
    readonly result: Awaited<ReturnType<typeof runScenario>>;
    readonly postMarker: string;
    readonly apiKey: string;
  }> {
    const root = mkdtempSync(join(tmpdir(), 'runner-openrouter-attestation-'));
    const binDir = join(root, 'bin');
    const credentialsPath = join(root, 'credentials.yaml');
    const postMarker = join(root, 'post-ran');
    const apiKey = `openrouter-${crypto.randomUUID()}`;
    const previousPath = Bun.env['PATH'];
    const previousRoot = Bun.env['SUPERPOWERS_ROOT'];
    const previousKey = Bun.env['OPENROUTER_API_KEY'];
    mkdirSync(binDir, { recursive: true });
    writeFakeSerfGauntlet(
      binDir,
      attestationTrajectory(
        options.responseIds ?? ['gen-route-1'],
        options.withUsage,
      ),
    );
    writeAttestationCredentials(credentialsPath);
    Bun.env['PATH'] = `${binDir}:${previousPath ?? ''}`;
    Bun.env['SUPERPOWERS_ROOT'] = makeSerfSuperpowersRoot(root);
    Bun.env['OPENROUTER_API_KEY'] = apiKey;

    try {
      const result = await runScenario({
        scenarioDir: makeAttestationScenario(root, postMarker),
        codingAgent: 'serf',
        codingAgentsDir: REAL_CODING_AGENTS,
        outRoot: join(root, 'results'),
        credential: options.credential ?? 'campaign',
        credentialsPath,
        ...(options.openRouterFetch === undefined
          ? {}
          : { openRouterFetch: options.openRouterFetch }),
        ...(options.openRouterAttestationWriter === undefined
          ? {}
          : {
              openRouterAttestationWriter: options.openRouterAttestationWriter,
            }),
      });
      return { result, postMarker, apiKey };
    } finally {
      if (previousPath === undefined) delete Bun.env['PATH'];
      else Bun.env['PATH'] = previousPath;
      if (previousRoot === undefined) delete Bun.env['SUPERPOWERS_ROOT'];
      else Bun.env['SUPERPOWERS_ROOT'] = previousRoot;
      if (previousKey === undefined) delete Bun.env['OPENROUTER_API_KEY'];
      else Bun.env['OPENROUTER_API_KEY'] = previousKey;
    }
  }

  test('a labeled OpenRouter Serf run attests every captured generation without persisting secrets or transcript content', async () => {
    let calls = 0;
    const fetchFn = injectedFetch(async () => {
      calls += 1;
      return new Response(JSON.stringify(generationPayload('gen-route-1')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { result, postMarker, apiKey } = await runAttestationScenario({
      openRouterFetch: fetchFn,
    });

    expect(result.verdict.final).toBe('pass');
    expect(calls).toBe(1);
    expect(existsSync(postMarker)).toBe(true);
    const sidecar = readFileSync(
      join(result.runDir, 'openrouter-generations.json'),
      'utf8',
    );
    expect(sidecar).not.toContain(apiKey);
    expect(sidecar).not.toContain(ATTESTATION_TRANSCRIPT);
    expect(JSON.parse(sidecar)).toMatchObject({
      charged_cost_usd: 0.0125,
      expected: {
        model: OPENROUTER_LABELS.model,
        provider: OPENROUTER_LABELS.provider,
      },
    });
  });

  test('unlabeled and non-OpenRouter Serf credentials never call the attestation fetch seam', async () => {
    let calls = 0;
    const fetchFn = injectedFetch(async () => {
      calls += 1;
      throw new Error('fetch must not run');
    });

    for (const credential of ['unlabeled', 'other_endpoint'] as const) {
      const { result } = await runAttestationScenario({
        credential,
        openRouterFetch: fetchFn,
      });
      expect(result.verdict.final).toBe('pass');
    }
    expect(calls).toBe(0);
  });

  const ATTESTATION_FAILURES: readonly [
    string,
    AttestationRunOptions & { readonly response?: Record<string, unknown> },
  ][] = [
    [
      'wrong provider',
      {
        responseIds: ['gen-route-1'] as const,
        response: { provider_name: 'Wrong Provider' },
      },
    ],
    [
      'wrong model',
      {
        responseIds: ['gen-route-1'] as const,
        response: { model: 'example/model-b' },
      },
    ],
    [
      'wrong preset',
      {
        responseIds: ['gen-route-1'] as const,
        response: { preset_id: '00000000-0000-4000-8000-000000000099' },
      },
    ],
    [
      'BYOK route',
      { responseIds: ['gen-route-1'] as const, response: { is_byok: true } },
    ],
    ['no generation ids', { responseIds: [] as const }],
    [
      'missing token evidence',
      { responseIds: ['gen-route-1'] as const, withUsage: false },
    ],
    [
      'null charged cost',
      { responseIds: ['gen-route-1'] as const, response: { total_cost: null } },
    ],
  ];

  test.each(
    ATTESTATION_FAILURES,
  )('OpenRouter attestation %s stops before post-checks as capture indeterminate', async (_name, options) => {
    const { response = {}, ...runOptions } = options;
    const fetchFn = injectedFetch(async () => {
      const id = options.responseIds?.[0] ?? 'gen-route-1';
      return new Response(JSON.stringify(generationPayload(id, response)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { result, postMarker } = await runAttestationScenario({
      ...runOptions,
      openRouterFetch: fetchFn,
    });

    expect(result.verdict.final).toBe('indeterminate');
    expect(result.verdict.error?.stage).toBe('capture');
    expect(existsSync(postMarker)).toBe(false);
  });

  test('OpenRouter metadata HTTP failures are capture indeterminate before post-checks', async () => {
    const { result, postMarker } = await runAttestationScenario({
      openRouterFetch: injectedFetch(
        async () => new Response('unavailable', { status: 503 }),
      ),
    });

    expect(result.verdict.final).toBe('indeterminate');
    expect(result.verdict.error?.stage).toBe('capture');
    expect(existsSync(postMarker)).toBe(false);
  });

  test('OpenRouter sidecar write failures are content-free capture indeterminate before post-checks', async () => {
    const errorMarker = 'sidecar-write-secret-marker';
    const { result, postMarker } = await runAttestationScenario({
      openRouterFetch: injectedFetch(async () => {
        return new Response(JSON.stringify(generationPayload('gen-route-1')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
      openRouterAttestationWriter: () => {
        throw new Error(errorMarker);
      },
    });

    expect(result.verdict.final).toBe('indeterminate');
    expect(result.verdict.error?.stage).toBe('capture');
    expect(result.verdict.error?.message).not.toContain(errorMarker);
    expect(existsSync(postMarker)).toBe(false);
  });
});
