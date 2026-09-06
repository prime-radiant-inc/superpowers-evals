import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpawnCommandRunner } from '../src/agents/command-runner.ts';
import { deleteProcessEnv, setProcessEnv } from '../src/env.ts';
import {
  captureNativeParent,
  inventoryNativeCapture,
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
import { mkdirSync, writeFileSync, appendFileSync, truncateSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('fixture-native 1'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--no-alt-screen --sandbox --ask-for-approval --model --permission-mode --strict-mcp-config --setting-sources'); process.exit(0); }
const home = process.env.HOME;
if (${JSON.stringify(mode)} === 'health-probe') await fetch(process.env.ANTHROPIC_BASE_URL, { method: 'HEAD' });
mkdirSync(home + '/raw', { recursive: true });
const configPath = home + (${JSON.stringify(runtime)} === 'codex' ? '/.codex/config.toml' : '/.claude.json');
const seededConfig = existsSync(configPath) ? (${JSON.stringify(runtime)} === 'codex' ? Bun.TOML.parse(readFileSync(configPath, 'utf8')) : JSON.parse(readFileSync(configPath, 'utf8'))) : undefined;
writeFileSync(home + '/observed.json', JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), pid: process.pid, seededConfig }));
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
    tmux: tmux ? realpathSync(tmux) : '/unavailable-test-tmux',
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
  inspectStorage: () => ({ type: 0x01021994, bsize: 4096, blocks: 65536 }),
  providerPort: 0,
};

localTest(
  'checks the live storage bound while accepting changing native output',
  async () => {
    const config = fixture();
    let inspections = 0;
    const result = await captureNativeParent(config, {
      ...testBoundary,
      inspectStorage() {
        inspections++;
        if (existsSync(join(config.output, 'home/raw/session.jsonl')))
          appendFileSync(
            join(config.output, 'home/raw/session.jsonl'),
            'live append\n',
          );
        return testBoundary.inspectStorage();
      },
    });
    expect(result.reason).toBeUndefined();
    expect(result.outcome).toBe('captured');
    expect(result.cleanup).toBe('stopped');
    expect(inspections).toBeGreaterThan(2);
    expect(
      readFileSync(join(config.output, 'home/raw/session.jsonl'), 'utf8'),
    ).toContain('live append');
  },
);

localTest(
  'refuses a capture mount whose capacity exceeds the output bound',
  async () => {
    const config = fixture();
    const result = await captureNativeParent(config, {
      ...testBoundary,
      inspectStorage: () => ({ type: 0x01021994, bsize: 4096, blocks: 65537 }),
    });
    expect(result.outcome).toBe('refused');
    expect(result.reason).toContain(
      'capture storage must be tmpfs bounded to 256 MiB',
    );
  },
);

localTest(
  'a startup health probe does not consume either native capture turn',
  async () => {
    const config = fixture('health-probe', 'claude');
    const result = await captureNativeParent(config, testBoundary);
    expect(result.reason).toBeUndefined();
    expect(result.outcome).toBe('captured');
    expect(result.cleanup).toBe('stopped');
    const requests = JSON.parse(
      readFileSync(join(config.output, 'requests.json'), 'utf8'),
    );
    expect(
      requests.map((record: { decision: string }) => record.decision),
    ).toEqual(['health-check', 'accepted', 'accepted']);
    expect(
      JSON.parse(readFileSync(join(config.output, 'inputs.json'), 'utf8')),
    ).toHaveLength(2);
  },
);

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
        if (runtime === 'codex') {
          expect(observed.seededConfig.projects).toEqual({
            [observed.cwd]: { trust_level: 'trusted' },
          });
        } else {
          expect(observed.seededConfig.hasCompletedOnboarding).toBe(true);
          expect(observed.seededConfig.theme).toBe('dark');
          expect(observed.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE).toBe('1');
        }
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

localTest(
  'still kills the actual fake native process when screen capture and receipt writes fail',
  async () => {
    for (const failure of ['screen', 'disk'] as const) {
      const config = fixture('stall');
      const runner = new SpawnCommandRunner();
      let storageUnavailable = false;
      const result = await captureNativeParent(config, {
        ...testBoundary,
        runner: {
          run(command, args, options) {
            if (
              failure === 'screen' &&
              args.includes('capture-pane') &&
              existsSync(join(config.output, 'home/observed.json'))
            )
              throw new Error('injected capture-pane failure');
            return runner.run(command, args, options);
          },
        },
        writeReceipt(path, body) {
          if (
            failure === 'disk' &&
            existsSync(join(config.output, 'home/observed.json'))
          )
            storageUnavailable = true;
          if (storageUnavailable)
            throw Object.assign(
              new Error('ENOSPC injected full output mount'),
              { code: 'ENOSPC' },
            );
          writeFileSync(path, body, { mode: 0o600 });
        },
      });
      expect(result.outcome).toBe('refused');
      expect(result.reason).toContain(
        failure === 'screen' ? 'capture-pane' : 'ENOSPC',
      );
      expect(result.cleanup).toBe('stopped');
      const observed = JSON.parse(
        readFileSync(join(config.output, 'home/observed.json'), 'utf8'),
      );
      expect(() => process.kill(observed.pid, 0)).toThrow();
      if (failure === 'disk') {
        expect(
          result.receiptFailures.some((f) => f.file === 'capture-result.json'),
        ).toBe(true);
        expect(existsSync(join(config.output, 'capture-result.json'))).toBe(
          false,
        );
      }
    }
  },
  20000,
);

test('inventory rejects real leaf, directory and ancestor replacement without hashing the replacement', () => {
  for (const replace of ['file', 'directory', 'ancestor', 'growth'] as const) {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'native-inventory-test-')),
    );
    roots.push(root);
    const capture = join(root, 'capture');
    const raw = join(capture, 'raw');
    mkdirSync(raw, { recursive: true });
    writeFileSync(join(raw, 'session.jsonl'), 'original');
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'session.jsonl'), 'must not be read');
    let replaced = false;
    expect(() =>
      inventoryNativeCapture(capture, true, {
        beforeOpen(path) {
          if (
            replaced ||
            path !== (replace === 'directory' ? 'raw' : 'raw/session.jsonl')
          )
            return;
          replaced = true;
          if (replace === 'file') {
            renameSync(join(raw, 'session.jsonl'), join(raw, 'saved'));
            symlinkSync(
              join(outside, 'session.jsonl'),
              join(raw, 'session.jsonl'),
            );
          } else if (replace === 'directory') {
            renameSync(raw, join(capture, 'saved'));
            symlinkSync(outside, raw);
          } else if (replace === 'ancestor') {
            renameSync(capture, join(root, 'saved'));
            symlinkSync(outside, capture);
          }
        },
        afterReadChunk(path) {
          if (replace === 'growth' && path === 'raw/session.jsonl')
            appendFileSync(join(raw, 'session.jsonl'), 'growth');
        },
      }),
    ).toThrow();
    expect(replaced).toBe(true);
    expect(readFileSync(join(outside, 'session.jsonl'), 'utf8')).toBe(
      'must not be read',
    );
  }
});

test('inventory records native launcher links without following file, directory or missing targets', () => {
  const config = fixture();
  mkdirSync(config.output);
  writeFileSync(join(config.output, 'session.jsonl'), 'raw session');
  for (const [name, target] of [
    ['apply_patch', config.binary],
    ['directory', config.output],
    ['missing.jsonl', '/missing-native-capture-target'],
  ])
    symlinkSync(target!, join(config.output, name!));
  for (const withDigests of [true, false]) {
    const inventory = inventoryNativeCapture(config.output, withDigests);
    expect(inventory.find((entry) => entry.path === 'apply_patch')).toEqual({
      kind: 'symlink',
      path: 'apply_patch',
      target: config.binary,
    });
    expect(inventory.find((entry) => entry.path === 'directory')).toEqual({
      kind: 'symlink',
      path: 'directory',
      target: config.output,
    });
    expect(inventory.find((entry) => entry.path === 'missing.jsonl')).toEqual({
      kind: 'symlink',
      path: 'missing.jsonl',
      target: '/missing-native-capture-target',
    });
    expect(inventory).toHaveLength(4);
    expect(inventory.find((entry) => entry.path === 'session.jsonl')).toEqual({
      path: 'session.jsonl',
      bytes: 11,
      sha256: withDigests
        ? createHash('sha256').update('raw session').digest('hex')
        : '',
    });
  }
});

test('inventory rejects replacement of a symlink before or after reading its target', () => {
  for (const timing of ['beforeOpen', 'afterReadLink'] as const) {
    const config = fixture();
    mkdirSync(config.output);
    const link = join(config.output, 'apply_patch');
    symlinkSync(config.binary, link);
    expect(() =>
      inventoryNativeCapture(config.output, true, {
        [timing](path: string) {
          if (path !== 'apply_patch') return;
          renameSync(link, join(config.output, 'original-link'));
          symlinkSync('/different-native-target', link);
        },
      }),
    ).toThrow('capture symlink changed during read');
  }
});
