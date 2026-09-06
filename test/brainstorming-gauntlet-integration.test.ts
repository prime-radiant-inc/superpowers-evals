// Explicit cross-repository instrument qualification. Run with GAUNTLET_ROOT
// pointing at the candidate Gauntlet checkout; no providers or keys are used.
import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteProcessEnv, getEnv, setProcessEnv } from '../src/env.ts';
import { observerCommand } from '../src/experiments/brainstorming-input-capture.ts';
import { repoRoot } from '../src/paths.ts';
import * as runner from '../src/runner/index.ts';
import { buildGauntletArgv } from '../src/runner/index.ts';
import { runSetup } from '../src/setup-step.ts';

const gauntletRoot = getEnv('GAUNTLET_ROOT');
test.skipIf(!gauntletRoot).each([false, true])(
  'Quorum setup and argv expose authenticated receipt pages through real TUI dispatch (deep=%s)',
  async (deepPaths) => {
    const runDir = realpathSync(
      mkdtempSync(join(tmpdir(), 'brainstorming-gauntlet-')),
    );
    try {
      const workdir = join(runDir, 'coding-agent-workdir');
      mkdirSync(workdir);
      const scenarioDir = join(
        repoRoot(),
        'scenarios',
        'brainstorming-todo-shared-intent',
      );
      const codingAgentHome = join(runDir, 'home');
      runSetup(scenarioDir, workdir, {
        QUORUM_CODING_AGENT_HOME: codingAgentHome,
      });
      const logDir = join(codingAgentHome, '.codex', 'sessions');
      mkdirSync(logDir, { recursive: true });
      runner.prepareObserverAfterSetup({
        scenario: 'brainstorming-todo-shared-intent',
        runDir,
        workdir,
        home: codingAgentHome,
        runtime: 'codex',
        binary: fakeBinary(runDir),
        campaign: null,
      });
      const rawLog = join(logDir, 'main.jsonl');
      const spec = join(workdir, 'spec.md');
      writeFileSync(spec, 'Learn React state and event handling');
      if (deepPaths) {
        const component = '\u0001'.repeat(160);
        const deep = join(workdir, component, component, component, component);
        mkdirSync(deep, { recursive: true });
        for (let i = 0; i < 17; i++)
          writeFileSync(
            join(deep, `${'\u0001'.repeat(120)}-${i}.md`),
            'Learn React state and event handling',
          );
      }
      writeFileSync(
        rawLog,
        `${JSON.stringify({ type: 'session_meta', payload: { id: 'main', cwd: workdir, cli_version: '0.144.3', originator: 'codex-tui', thread_source: 'user', source: 'cli' } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Please review spec.md.' }] } })}\n`,
      );
      const story = join(runDir, 'story.md');
      writeFileSync(
        story,
        '---\nid: capture-integration\ntitle: Observe input capture\nstatus: ready\n---\nObserve the local subject.\n',
      );
      const argv = buildGauntletArgv({
        storyPath: story,
        targetBinary: 'local',
        runDir,
        tuiInputGuard: join(runDir, 'gauntlet-agent', 'tui-input-guard'),
      });
      const { parseArgs } = await import(
        join(gauntletRoot!, 'src/cli/args.ts')
      );
      const { run } = await import(join(gauntletRoot!, 'src/cli/run.ts'));
      const { loadConfig } = await import(join(gauntletRoot!, 'src/config.ts'));
      const { makeScriptedClient, step, report } = await import(
        join(gauntletRoot!, 'test/integration/helpers.ts')
      );
      const args = parseArgs(['bun', 'gauntlet', ...argv]);
      const reply = "I've read it; that captures what I want. Go ahead.";
      // This local subject checks real persisted receipt bytes before accepting
      // any reply; the actor below supplies only an ordinary terminal command.
      const subject = join(runDir, 'subject.ts');
      const delivered = join(runDir, 'accepted.json');
      writeFileSync(
        subject,
        `import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const dir = ${JSON.stringify(join(runDir, 'brainstorming-evidence'))};
const receipts = readdirSync(dir).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(dir + '/' + n, 'utf8')));
const receipt = receipts.find(r => r.artifact_path === 'spec.md' && Buffer.from(r.content_base64,'base64').toString() === 'Learn React state and event handling' && r.source_prefix.after_line === 2);
if (!receipt) process.exit(8);
writeFileSync(${JSON.stringify(delivered)}, JSON.stringify({ reply: Bun.argv[2], receipt }));
`,
      );
      const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
      let actorReceipt: {
        observation_id: string;
        artifact_path: string;
        content_base64: string;
      } | null = null;
      let selectedReceipt: { path: string; observation_id: string } | null =
        null;
      const actorJson = (messages: unknown[], id: string): unknown => {
        const message = messages.find(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            (message as { tool_call_id?: string }).tool_call_id === id,
        ) as { content: string } | undefined;
        if (!message) return undefined;
        const json = message.content
          .split('\n')
          .find((line) => line.startsWith('{'));
        if (!json) throw new Error(`Actor did not receive JSON from ${id}`);
        return JSON.parse(json);
      };
      const responses = [
        step('reply', 'type_and_submit', {
          text: `bun ${quote(subject)} ${quote(reply)}`,
        }),
        step('discover', 'bash', {
          command: observerCommand(workdir, 'observer-receipts'),
        }),
        report(
          'pass',
          'accepted',
          'Actor discovered and read the exact persisted receipt',
        ),
      ];
      const scripted = makeScriptedClient(responses, 1000);
      await run({
        ...args,
        target: 'local',
        adapterType: args.adapter,
        config: loadConfig(args.cli, {}),
        clientFactory: () => ({
          ...scripted,
          async chat(messages: unknown[]) {
            const discovered = actorJson(messages, 'discover') as
              | {
                  receipts: {
                    path: string;
                    observation_id: string;
                    artifact_path: string;
                  }[];
                }
              | undefined;
            if (discovered && !selectedReceipt) {
              expect(
                Buffer.byteLength(`${JSON.stringify(discovered)}\n`),
              ).toBeLessThanOrEqual(32 * 1024);
              const selected = discovered.receipts.find((receipt) =>
                deepPaths
                  ? receipt.artifact_path.includes('/')
                  : receipt.artifact_path === 'spec.md',
              );
              if (!selected)
                throw new Error('Actor cannot discover the spec receipt');
              selectedReceipt = selected;
              return step('receipt-read', 'bash', {
                command: observerCommand(
                  workdir,
                  'observer-read',
                  Buffer.from(selected.path).toString('base64'),
                ),
              });
            }
            const read = actorJson(messages, 'receipt-read') as
              | { content_base64: string }
              | undefined;
            if (read) {
              actorReceipt = JSON.parse(
                Buffer.from(read.content_base64, 'base64').toString(),
              );
              if (
                actorReceipt?.observation_id !== selectedReceipt?.observation_id
              )
                throw new Error('Actor receipt identity changed');
            }
            return scripted.chat(messages);
          },
        }),
      });
      expect(JSON.parse(readFileSync(delivered, 'utf8')).reply).toBe(reply);
      if (!actorReceipt || !selectedReceipt)
        throw new Error('Actor never received the receipt');
      const observed = actorReceipt as {
        observation_id: string;
        artifact_path: string;
        content_base64: string;
      };
      const selected = selectedReceipt as {
        path: string;
        observation_id: string;
      };
      expect(observed.observation_id).toBe(selected.observation_id);
      expect(Buffer.from(observed.content_base64, 'base64').toString()).toBe(
        'Learn React state and event handling',
      );
      expect(
        JSON.parse(readFileSync(selected.path, 'utf8')).observation_id,
      ).toBe(observed.observation_id);
      expect(
        readdirSync(join(runDir, 'brainstorming-evidence')).length,
      ).toBeGreaterThan(0);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  },
  30_000,
);

test('runner installs observer after setup selects a nested launch cwd', () => {
  const runDir = realpathSync(
    mkdtempSync(join(tmpdir(), 'observer-sentinel-')),
  );
  try {
    const workdir = join(runDir, 'coding-agent-workdir');
    const home = join(runDir, 'home');
    const nested = join(workdir, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(workdir, '.quorum-launch-cwd'), nested);
    const launch = runner.prepareObserverAfterSetup({
      scenario: 'brainstorming-todo-shared-intent',
      runDir,
      workdir,
      home,
      runtime: 'codex',
      binary: fakeBinary(runDir),
      campaign: null,
    });
    expect(launch).toBe(nested);
    const binding = JSON.parse(
      readFileSync(
        join(runDir, 'gauntlet-agent/observer-binding.json'),
        'utf8',
      ),
    );
    expect(binding.launch_cwd).toBe(nested);
    expect(binding.workdir).toBe(workdir);
    expect(binding.home).toBe(home);
    expect(
      readFileSync(
        join(runDir, 'gauntlet-agent/context/BRAINSTORMING-OBSERVER.md'),
        'utf8',
      ).length,
    ).toBeGreaterThan(0);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

function fakeBinary(runDir: string, line = 'codex-cli 0.144.3') {
  const binary = join(runDir, 'version-probe');
  writeFileSync(
    binary,
    `#!/usr/bin/env bun\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(join(runDir, 'probe-env.json'))},JSON.stringify({home:process.env.HOME,key:process.env['ANTHROPIC_API_KEY']??null}));\nconsole.log(${JSON.stringify(line)});\n`,
  );
  chmodSync(binary, 0o700);
  return binary;
}
test('observer version probe rejects wrong builds and substring lookalikes under private HOME', () => {
  const runDir = realpathSync(mkdtempSync(join(tmpdir(), 'observer-version-')));
  const saved = getEnv('ANTHROPIC_API_KEY');
  try {
    const workdir = join(runDir, 'coding-agent-workdir');
    const home = join(runDir, 'home');
    mkdirSync(workdir, { recursive: true });
    setProcessEnv('ANTHROPIC_API_KEY', 'sentinel-secret');
    for (const version of [
      'codex-cli 0.144.4',
      'codex-cli 0.144.3-malicious',
    ]) {
      expect(() =>
        runner.prepareObserverAfterSetup({
          scenario: 'brainstorming-todo-shared-intent',
          runDir,
          workdir,
          home,
          runtime: 'codex',
          binary: fakeBinary(runDir, version),
          campaign: null,
        }),
      ).toThrow();
      const probe = JSON.parse(
        readFileSync(join(runDir, 'probe-env.json'), 'utf8'),
      );
      expect(probe.home.startsWith(runDir)).toBe(true);
      expect(probe.home).not.toBe(home);
      expect(probe.key).toBeNull();
    }
  } finally {
    if (saved === undefined) deleteProcessEnv('ANTHROPIC_API_KEY');
    else setProcessEnv('ANTHROPIC_API_KEY', saved);
    rmSync(runDir, { recursive: true, force: true });
  }
});
