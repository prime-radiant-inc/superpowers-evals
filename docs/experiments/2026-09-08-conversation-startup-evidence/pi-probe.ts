import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultCommandRunner } from '../../../src/agents/command-runner.ts';
import { PiAgent } from '../../../src/agents/pi.ts';
import {
  captureTokenUsage,
  captureToolCalls,
  snapshotDir,
} from '../../../src/capture/index.ts';
import { trajectoryExposureMs } from '../../../src/campaign/sensors.ts';
import { loadAgentConfigForValidation } from '../../../src/contracts/agent-config.ts';
import { CredentialSchema } from '../../../src/contracts/credential.ts';
import { getEnv, setProcessEnv } from '../../../src/env.ts';
import { populateContextDir } from '../../../src/runner/context.ts';
import { buildContextSubstitutions } from '../../../src/runner/index.ts';

const IMAGE =
  'sha256:01fb1cd08f1e31c82fccedbaadead09e6ff97bca1f5d66f2f0904728ad536e8c';
const MODEL = 'gpt-5.6-sol';
const PROMPT = 'Please reply with a short greeting.';
const ANSWER = 'Hello from the offline Pi probe.';
const root = '/probe';
const source = '/workspace/probe-source';
const socket = '/tmp/qpi.sock';
const pricingDir = join(
  source,
  'docs/experiments/2026-09-06-pr2258-pricing',
);
const pricingPath = join(pricingDir, 'current.json');
const pricingSha256 =
  '6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b';

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  return [...new Bun.Glob('**/*.jsonl').scanSync({
    cwd: path,
    absolute: true,
  })].sort();
}

function rows(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function text(row: Record<string, unknown>): string {
  const message = row['message'];
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      const value = (block as Record<string, unknown>)['text'];
      return typeof value === 'string' ? value : '';
    })
    .join('');
}

async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error('native response timed out');
    await Bun.sleep(100);
  }
}

function item() {
  return {
    id: 'msg_offline_pi_probe',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: ANSWER, annotations: [] }],
  };
}

function response() {
  return {
    id: 'resp_offline_pi_probe',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: MODEL,
    output: [item()],
    usage: {
      input_tokens: 125,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens: 25,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 150,
    },
  };
}

function responseBody(): string {
  const events = [
    { type: 'response.created', response: response() },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item(), status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      delta: ANSWER,
    },
    { type: 'response.output_item.done', output_index: 0, item: item() },
    { type: 'response.completed', response: response() },
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
}

assert.equal(getEnv('PROBE_IMAGE_ID'), IMAGE);
const sourceRef = getEnv('PROBE_QUORUM_SHA');
assert(sourceRef?.match(/^[0-9a-f]{40}$/));
assert.equal(realpathSync(getEnv('OBOL_PRICING_DIR') ?? ''), pricingDir);
assert.equal(hash(pricingPath), pricingSha256);
const pricing = JSON.parse(readFileSync(pricingPath, 'utf8')) as Record<
  string,
  unknown
>;
const namespaces = pricing['namespaces'] as Record<string, unknown>;
const litellm = namespaces['litellm'] as Record<string, unknown>;
const modelRates = litellm[MODEL] as Record<string, number>;
assert.equal(pricing['as_of'], '2026-09-06');
assert.deepEqual(modelRates, {
  input: 4,
  output: 20,
  cache_read: 0.4,
  cache_write: 5,
  tier_boundary: 272000,
  input_above: 8,
  output_above: 30,
  cache_read_above: 0.8,
  cache_write_above: 10,
});
mkdirSync(root, { recursive: true });
const run = join(
  root,
  'deep',
  ...Array.from({ length: 6 }, (_, index) =>
    `part-${index}-${'x'.repeat(43)}`,
  ),
  'run',
);
const workdir = join(run, 'coding-agent-workdir');
const home = join(run, 'private home');
const outerHome = join(run, 'outer home');
const configDir = join(home, '.pi', 'agent');
const sessions = join(configDir, 'sessions');
const launcher = join(run, 'gauntlet-agent', 'context', 'launch-agent');
for (const dir of [
  workdir,
  home,
  outerHome,
  join(home, '.config'),
  join(home, '.cache'),
  join(home, '.local', 'share'),
  join(home, '.local', 'state'),
  join(home, '.tmp'),
]) {
  mkdirSync(dir, { recursive: true });
}
const encoded = `--${workdir
  .replace(/^[/\\]/, '')
  .replace(/[/\\:]/g, '-')}--`;
assert(Buffer.byteLength(encoded) > 255);

let requestCount = 0;
let requestShape: Record<string, unknown> | undefined;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 18181,
  async fetch(request) {
    requestCount += 1;
    if (requestCount > 1) return new Response('request limit', { status: 429 });
    const body = (await request.json()) as Record<string, unknown>;
    const url = new URL(request.url);
    requestShape = {
      method: request.method,
      path: url.pathname,
      model: body['model'],
      dummy_auth:
        request.headers.get('authorization') ===
        'Bearer offline-pi-probe-dummy',
    };
    return new Response(responseBody(), {
      headers: { 'content-type': 'text/event-stream' },
    });
  },
});

try {
  const keyEnv = 'QUORUM_OFFLINE_PI_PROBE_KEY';
  setProcessEnv(keyEnv, 'offline-pi-probe-dummy');
  const config = loadAgentConfigForValidation(
    join(source, 'coding-agents'),
    'pi',
  );
  new PiAgent(config).provision(
    {
      configDir,
      workdir,
      skeletonRoot: join(source, 'coding-agents'),
      superpowers: { mode: 'none' },
    },
    defaultCommandRunner,
    CredentialSchema.parse({
      model: MODEL,
      api: 'openai-responses',
      base_url: 'http://127.0.0.1:18181/v1',
      api_key_env: keyEnv,
      auth: 'api-key',
      harnesses: ['pi'],
    }),
  );
  const substitutions = buildContextSubstitutions({
    launchCwd: workdir,
    launchAgentPath: launcher,
    runHomeDir: home,
    family: 'pi',
    superpowers: { mode: 'none' },
  });
  substitutions['$PI_ENV_FILE'] = join(configDir, 'pi.env');
  populateContextDir({
    codingAgentsDir: join(source, 'coding-agents'),
    codingAgent: 'pi',
    runDir: run,
    substitutions,
    required: true,
    forbiddenPlaceholders: ['$SUPERPOWERS_PLUGIN_ARGS', '$SUPERPOWERS_ROOT'],
  });
  const snapshot = snapshotDir(sessions, config.session_log_glob);
  writeFileSync(
    join(root, 'ready.json'),
    `${JSON.stringify({ launcher, outerHome })}\n`,
  );

  const session = await waitFor(() => {
    const path = files(sessions)[0];
    if (path === undefined) return undefined;
    return rows(path).some((row) => text(row).includes(ANSWER))
      ? path
      : undefined;
  });
  const native = rows(session);
  const header = native.find((row) => row['type'] === 'session');
  const user = native.find((row) => text(row).includes(PROMPT));
  const assistant = native.find((row) => text(row).includes(ANSWER));
  const message = assistant?.['message'] as Record<string, unknown>;
  const usage = message['usage'] as Record<string, unknown>;
  assert.equal(header?.['cwd'], workdir);
  assert.equal(dirname(session), sessions);
  assert.equal(requestCount, 1);
  assert.equal(requestShape?.['method'], 'POST');
  assert.equal(requestShape?.['path'], '/v1/responses');
  assert.equal(requestShape?.['model'], MODEL);
  assert.equal(requestShape?.['dummy_auth'], true);
  assert.equal(typeof user?.['timestamp'], 'string');
  assert.equal(typeof assistant?.['timestamp'], 'string');
  assert.equal(usage['input'], 120);
  assert.equal(usage['cacheRead'], 5);
  assert.equal(usage['output'], 25);
  assert.equal(usage['totalTokens'], 150);
  assert.equal(
    (usage['cost'] as Record<string, unknown>)['total'],
    0,
  );
  assert.equal(existsSync(join(outerHome, '.pi', 'agent', 'sessions')), false);
  writeFileSync(join(root, 'response-ready'), 'ready\n');

  await waitFor(() => {
    const result = Bun.spawnSync([
      'tmux',
      '-S',
      socket,
      'has-session',
      '-t',
      'probe',
    ]);
    return result.exitCode === 0 ? undefined : true;
  });

  const captureArgs = {
    logDir: sessions,
    logGlob: config.session_log_glob,
    snapshot,
    normalizer: 'pi',
    runDir: run,
    launchCwd: workdir,
  };
  const capture = captureToolCalls(captureArgs);
  assert.equal(capture.availability, 'available');
  assert.deepEqual(capture.sourceLogs, [session]);
  const trajectory = JSON.parse(
    readFileSync(join(run, 'trajectory.json'), 'utf8'),
  ) as Record<string, unknown>;
  const steps = trajectory['steps'] as Record<string, unknown>[];
  assert.equal(trajectory['session_id'], header?.['id']);
  assert.equal(steps.length, 2);
  assert.deepEqual(
    steps.map((step) => step['timestamp']),
    [user?.['timestamp'], assistant?.['timestamp']],
  );
  assert(
    steps.every(
      (step) =>
        (step['extra'] as Record<string, unknown>)['source_session_id'] ===
        header?.['id'],
    ),
  );
  const agentStep = steps.find((step) => step['source'] === 'agent');
  assert.equal(
    (agentStep?.['metrics'] as Record<string, unknown>)['cost_usd'],
    undefined,
  );
  const exposure = trajectoryExposureMs(run);
  assert.equal(exposure, Date.parse(user?.['timestamp'] as string));
  const usagePath = await captureTokenUsage(captureArgs);
  assert(usagePath);
  const frozenUsage = JSON.parse(
    readFileSync(usagePath, 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(frozenUsage['total_input'], 120);
  assert.equal(frozenUsage['total_cache_read'], 5);
  assert.equal(frozenUsage['total_output'], 25);
  assert.equal(frozenUsage['total_tokens'], 150);
  const expectedCost =
    (120 * modelRates['input'] +
      5 * modelRates['cache_read'] +
      25 * modelRates['output']) /
    1_000_000;
  assert.equal(expectedCost, 0.000982);
  assert.equal(frozenUsage['est_cost_usd'], expectedCost);
  assert.equal(frozenUsage['pricing_as_of'], pricing['as_of']);
  assert.deepEqual(frozenUsage['unpriced_models'], []);

  const pi = realpathSync('/usr/bin/pi');
  const packageRoot = resolve(dirname(pi), '..');
  const version = (JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8'),
  ) as Record<string, unknown>)['version'];
  assert.equal(version, '0.80.7');
  const receipt = {
    ok: true,
    source_ref: sourceRef,
    image: IMAGE,
    external_network: 'none',
    installed_pi: {
      version,
      binary: pi,
      main_sha256: hash(join(packageRoot, 'dist', 'main.js')),
      session_manager_sha256: hash(
        join(packageRoot, 'dist', 'core', 'session-manager.js'),
      ),
    },
    launcher: {
      sha256: hash(launcher),
      deep_component_bytes: Buffer.byteLength(encoded),
      private_session_selected: dirname(session) === sessions,
      outer_home_session_created: false,
    },
    provider: { requests: requestCount, request_limit: 1, requestShape },
    native: {
      session_id: header?.['id'],
      session_sha256: hash(session),
      user_timestamp: user?.['timestamp'],
      assistant_timestamp: assistant?.['timestamp'],
      usage,
    },
    capture: {
      availability: capture.availability,
      source_logs: capture.sourceLogs.length,
      steps: steps.length,
      exposure: new Date(exposure).toISOString(),
      frozen_usage: frozenUsage,
      pricing: {
        path: pricingPath,
        sha256: pricingSha256,
        as_of: pricing['as_of'],
        namespace: 'litellm',
        model: MODEL,
        rates_per_million: modelRates,
        arithmetic:
          '(120 fresh * 4 + 5 cached * 0.4 + 25 output * 20) / 1000000',
        expected_cost_usd: expectedCost,
      },
    },
    termination: { tmux_session_gone: true, outer_deadline_seconds: 150 },
  };
  writeFileSync(
    join(root, 'native-receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  server.stop(true);
}
