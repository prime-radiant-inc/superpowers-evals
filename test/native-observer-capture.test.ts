import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpawnCommandRunner } from '../src/agents/command-runner.ts';
import { deleteProcessEnv, setProcessEnv } from '../src/env.ts';
import {
  captureNativeParent,
  type NativeCaptureConfig,
} from './linux/fixtures/native-observer-capture.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const tmux = Bun.which('tmux');
const localTest = test.skipIf(!tmux);
function fixture(mode = 'normal', runtime: 'codex' | 'claude' = 'codex') {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'native-capture-test-')),
  );
  roots.push(root);
  const binary = join(root, 'fake-native');
  writeFileSync(
    `${binary}.ts`,
    `#!${process.execPath}
import { mkdirSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('fixture-native 1'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--no-alt-screen --sandbox --ask-for-approval --model --permission-mode --strict-mcp-config --setting-sources'); process.exit(0); }
const home = process.env.HOME;
mkdirSync(home + '/raw', { recursive: true });
writeFileSync(home + '/observed.json', JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), pid: process.pid }));
if (${JSON.stringify(mode)} === 'oversize') { writeFileSync(home + '/oversize', ''); truncateSync(home + '/oversize', 257 * 1024 * 1024); }
console.log('fixture ready');
const messages = [];
for await (const text of createInterface({ input: process.stdin })) {
 if (!text) continue;
 appendFileSync(home + '/raw/session.jsonl', JSON.stringify({ role: 'user', text }) + '\\n');
 if (${JSON.stringify(mode)} === 'stall') continue;
 messages.push({ role: 'user', content: text });
 const protocol = process.env.ANTHROPIC_BASE_URL ? 'messages' : 'responses';
 const url = process.env.ANTHROPIC_BASE_URL || process.argv[process.argv.indexOf('-c') + 1];
 const base = protocol === 'messages' ? url + '/v1' : process.argv.find(x => x.startsWith('model_providers.quorum.base_url=')).split('=')[1].replaceAll('"', '');
 const body = { model: protocol === 'messages' ? 'claude-opus-5' : 'gpt-6-astra', stream: true, tools: [], [protocol === 'messages' ? 'messages' : 'input']: messages };
 const response = await fetch(base + (${JSON.stringify(mode)} === 'route' ? '/unexpected' : '/' + protocol), { method: 'POST', headers: { 'content-type': 'application/json', ...(protocol === 'messages' ? { 'x-api-key': process.env.ANTHROPIC_API_KEY } : { authorization: 'Bearer ' + process.env.CODEX_PROVIDER_API_KEY }) }, body: JSON.stringify(body) });
 const wire = await response.text();
 appendFileSync(home + '/raw/session.jsonl', JSON.stringify({ wire }) + '\\n');
 for (const line of wire.split('\\n')) if (line.startsWith('data: ')) { const e = JSON.parse(line.slice(6)); if (e.type === 'response.output_text.done') console.log(e.text); if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') process.stdout.write(e.delta.text); }
 console.log('');
}
`,
  );
  writeFileSync(
    binary,
    `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' 'fixture-native 1'; exit 0; fi
if [ "$1" = --help ]; then printf '%s\\n' '--no-alt-screen --sandbox --ask-for-approval --model --permission-mode --strict-mcp-config --setting-sources'; exit 0; fi
exec '${process.execPath}' '${binary}.ts' "$@"
`,
  );
  chmodSync(binary, 0o700);
  const config: NativeCaptureConfig = {
    runtime,
    binary,
    expectedVersion: 'fixture-native 1',
    expectedExecutableSha256: createHash('sha256')
      .update(readFileSync(binary))
      .digest('hex'),
    tmux: realpathSync(tmux!),
    path: `${join(process.execPath, '..')}:/usr/bin:/bin`,
    output: join(root, 'capture'),
    imageId: `sha256:${'5'.repeat(64)}`,
    evalsCommit: 'e'.repeat(40),
    gauntletCommit: 'a'.repeat(40),
    expectedBunVersion: Bun.version,
    deadlineMs: 7000,
    startupMs: 300,
  };
  return config;
}
const testBoundary = {
  verifyBoundary: () => ({ kind: 'explicit-fake-native-test' }),
  providerPort: 0,
};

localTest(
  'captures two real terminal submissions with private fresh environment and kills its tmux server',
  async () => {
    setProcessEnv('CAPTURE_TEST_FORBIDDEN', 'must-not-inherit');
    try {
      for (const runtime of ['codex', 'claude'] as const) {
        const config = fixture('normal', runtime);
        const result = await captureNativeParent(config, testBoundary);
        expect(result.reason).toBeUndefined();
        expect(result.outcome).toBe('captured');
        expect(result.cleanup).toBe('stopped');
        const observed = JSON.parse(
          readFileSync(join(config.output, 'home/observed.json'), 'utf8'),
        );
        expect(observed.env.CAPTURE_TEST_FORBIDDEN).toBeUndefined();
        expect(observed.env.HOME).toBe(join(config.output, 'home'));
        expect(observed.cwd).toBe(join(config.output, 'workdir'));
        expect(observed.argv).not.toContain('exec');
        expect(observed.argv).not.toContain('-p');
        expect(
          observed.env[
            runtime === 'codex' ? 'CODEX_PROVIDER_API_KEY' : 'ANTHROPIC_API_KEY'
          ],
        ).toBe('native-capture-fake');
        expect(() => process.kill(observed.pid, 0)).toThrow();
        const ledger = JSON.parse(
          readFileSync(join(config.output, 'requests.json'), 'utf8'),
        );
        expect(ledger).toHaveLength(2);
        expect(
          ledger.every((r: { decision: string }) => r.decision === 'accepted'),
        ).toBe(true);
        expect(
          JSON.parse(readFileSync(join(config.output, 'inputs.json'), 'utf8')),
        ).toHaveLength(2);
        expect(
          result.files.some((f) => f.path === 'home/raw/session.jsonl'),
        ).toBe(true);
        expect(statSync(config.output).mode & 0o777).toBe(0o700);
        expect(
          statSync(join(config.output, 'requests.json')).mode & 0o777,
        ).toBe(0o600);
        expect(result.identity?.executable.sha256).toHaveLength(64);
      }
    } finally {
      deleteProcessEnv('CAPTURE_TEST_FORBIDDEN');
    }
  },
  20000,
);

localTest(
  'preserves an unexpected request refusal and stops the native process',
  async () => {
    const config = fixture('route');
    const result = await captureNativeParent(config, testBoundary);
    expect(result.outcome).toBe('refused');
    expect(result.cleanup).toBe('stopped');
    expect(
      JSON.parse(readFileSync(join(config.output, 'requests.json'), 'utf8'))[0]
        .path,
    ).toBe('/v1/unexpected');
    expect(existsSync(join(config.output, 'home/raw/session.jsonl'))).toBe(
      true,
    );
  },
);

localTest(
  'bounds an unresponsive TUI and retains deadline and cleanup receipts',
  async () => {
    const config = { ...fixture('stall'), deadlineMs: 3500 };
    const result = await captureNativeParent(config, testBoundary);
    expect(result.outcome).toBe('refused');
    expect(result.reason).toContain('deadline');
    expect(result.cleanup).toBe('stopped');
    const observed = JSON.parse(
      readFileSync(join(config.output, 'home/observed.json'), 'utf8'),
    );
    expect(() => process.kill(observed.pid, 0)).toThrow();
  },
);

localTest(
  'refuses selected version mismatch before launching the interactive binary',
  async () => {
    const config = { ...fixture(), expectedVersion: 'wrong build' };
    const result = await captureNativeParent(config, testBoundary);
    expect(result.outcome).toBe('refused');
    expect(result.reason).toContain('version');
    expect(existsSync(join(config.output, 'home/observed.json'))).toBe(false);
  },
);

test('checks the container boundary before launching any executable or creating outputs', async () => {
  const config = fixture();
  await expect(
    captureNativeParent(config, {
      verifyBoundary: () => {
        throw new Error('network none required');
      },
    }),
  ).rejects.toThrow('network none required');
  expect(existsSync(config.output)).toBe(false);
});

localTest(
  'refuses excess raw output while retaining cleanup evidence',
  async () => {
    const config = fixture('oversize');
    const result = await captureNativeParent(config, testBoundary);
    expect(result.outcome).toBe('refused');
    expect(result.reason).toContain('output limit');
    expect(result.cleanup).toBe('stopped');
  },
  20000,
);

localTest(
  'refuses an existing output directory without altering its files',
  async () => {
    const config = fixture();
    mkdirSync(config.output);
    writeFileSync(join(config.output, 'existing'), 'retain me');
    await expect(captureNativeParent(config, testBoundary)).rejects.toThrow(
      'fresh directory',
    );
    expect(readFileSync(join(config.output, 'existing'), 'utf8')).toBe(
      'retain me',
    );
  },
);

localTest(
  'the CLI cannot bypass the native container boundary for a fake executable',
  () => {
    const config = fixture();
    const path = join(config.output, '..', 'config.json');
    writeFileSync(path, JSON.stringify(config));
    const result = new SpawnCommandRunner().run(
      process.execPath,
      [
        join(import.meta.dir, 'linux/fixtures/native-observer-capture.ts'),
        path,
      ],
      { env: { PATH: config.path }, timeoutMs: 5000 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/container|network|read-only|ELF/);
    expect(existsSync(config.output)).toBe(false);
  },
);

localTest(
  'refuses an executable digest mismatch before any native invocation',
  async () => {
    const config = { ...fixture(), expectedExecutableSha256: '0'.repeat(64) };
    const result = await captureNativeParent(config, testBoundary);
    expect(result.reason).toContain('digest mismatch');
    expect(result.outcome).toBe('refused');
    expect(existsSync(join(config.output, 'home/observed.json'))).toBe(false);
  },
  20000,
);
