// Explicit cross-repository instrument qualification. Run with GAUNTLET_ROOT
// pointing at the candidate Gauntlet checkout; no providers or keys are used.
import { expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEnv } from '../src/env.ts';
import { repoRoot } from '../src/paths.ts';
import { buildGauntletArgv } from '../src/runner/index.ts';
import { runSetup } from '../src/setup-step.ts';

const gauntletRoot = getEnv('GAUNTLET_ROOT');
test.skipIf(!gauntletRoot)(
  'Quorum setup and argv activate capture through Gauntlet run and real TUI dispatch',
  async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'brainstorming-gauntlet-'));
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
      const rawLog = join(logDir, 'main.jsonl');
      const spec = join(workdir, 'spec.md');
      writeFileSync(spec, 'Learn React state and event handling');
      writeFileSync(
        rawLog,
        `${JSON.stringify({ type: 'session_meta', payload: { id: 'main', cwd: workdir, source: 'cli' } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Please review spec.md.' }] } })}\n`,
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
const receipt = receipts.find(r => r.artifact_path === ${JSON.stringify(spec)} && r.content === 'Learn React state and event handling' && r.after_line === 2);
if (!receipt) process.exit(8);
writeFileSync(${JSON.stringify(delivered)}, JSON.stringify({ reply: Bun.argv[2], receipt }));
`,
      );
      const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
      await run({
        ...args,
        target: 'local',
        adapterType: args.adapter,
        config: loadConfig(args.cli, {}),
        clientFactory: () =>
          makeScriptedClient(
            [
              step('reply', 'type_and_submit', {
                text: `bun ${quote(subject)} ${quote(reply)}`,
              }),
              report(
                'pass',
                'accepted',
                'Local subject validated persisted evidence',
              ),
            ],
            1000,
          ),
      });
      expect(JSON.parse(readFileSync(delivered, 'utf8')).reply).toBe(reply);
      expect(
        readdirSync(join(runDir, 'brainstorming-evidence')).length,
      ).toBeGreaterThan(0);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  },
  30_000,
);
