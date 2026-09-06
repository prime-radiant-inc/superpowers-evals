import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareObserverAfterSetup } from '../src/runner/index.ts';

function fixture(version: string) {
  const runDir = realpathSync(mkdtempSync(join(tmpdir(), 'observer-build-')));
  const home = join(runDir, 'home');
  const workdir = join(runDir, 'coding-agent-workdir');
  mkdirSync(workdir);
  const binary = join(runDir, 'subject');
  writeFileSync(
    binary,
    `#!/usr/bin/env bun\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(join(runDir, 'probe.json'))}, JSON.stringify({home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME}));\nconsole.log(${JSON.stringify(version)});\n`,
  );
  chmodSync(binary, 0o700);
  return {
    args: {
      scenario: 'brainstorming-todo-shared-intent',
      runDir,
      home,
      workdir,
      binary,
      campaign: null,
    },
    assertProbeCleaned() {
      const probe = JSON.parse(
        readFileSync(join(runDir, 'probe.json'), 'utf8'),
      );
      expect(probe.home.startsWith(`${runDir}/.observer-version-home-`)).toBe(
        true,
      );
      expect(probe.home).not.toBe(home);
      expect(existsSync(probe.home)).toBe(false);
      expect(probe.xdg.startsWith(probe.home)).toBe(true);
    },
    cleanup() {
      rmSync(runDir, { recursive: true, force: true });
    },
  };
}

test.each([
  ['codex', 'codex-cli 0.144.3', '0.144.3', '.codex/sessions'],
  ['codex', 'codex-cli 0.146.0', '0.146.0', '.codex/sessions'],
  ['claude', '2.1.209 (Claude Code)', '2.1.209', '.claude/projects'],
])('observer binds the inspected %s build %s', (runtime, line, version, transcriptDir) => {
  const f = fixture(line!);
  try {
    expect(
      prepareObserverAfterSetup({
        ...f.args,
        runtime: runtime!,
        cliPin: version,
      }),
    ).toBe(f.args.workdir);
    const binding = JSON.parse(
      readFileSync(
        join(f.args.runDir, 'gauntlet-agent/observer-binding.json'),
        'utf8',
      ),
    );
    expect(binding.runtime).toBe(runtime);
    expect(binding.cli_version).toBe(version);
    expect(
      binding.roots.find((root: { id: string }) => root.id === 'transcripts')
        .path,
    ).toBe(join(f.args.home, transcriptDir!));
    const trace = binding.roots.find(
      (root: { kind: string }) => root.kind === 'tool_trace',
    );
    expect(trace?.path ?? null).toBe(
      runtime === 'codex' && version === '0.146.0'
        ? join(f.args.home, '.codex/rollout-traces')
        : null,
    );
    f.assertProbeCleaned();
  } finally {
    f.cleanup();
  }
});

test.each([
  ['codex', 'codex-cli 0.146.1', undefined],
  ['codex', 'codex-cli 0.146.0-malicious', undefined],
  ['codex', 'prefix codex-cli 0.146.0', undefined],
  ['codex', '2.1.209 (Claude Code)', undefined],
  ['codex', 'codex-cli 0.146.0', '0.144.3'],
  ['codex', 'codex-cli 0.144.3', '0.146.0'],
  ['claude', '2.1.210 (Claude Code)', undefined],
  ['claude', '2.1.209 (Claude Code) suffix', undefined],
  ['claude', '2.1.209', undefined],
  ['claude', '2.1.209 (Codex)', undefined],
  ['claude', 'codex-cli 0.146.0', undefined],
  ['claude', '2.1.209 (Claude Code)', '2.1.210'],
  ['codex', '', undefined],
  ['claude', '', undefined],
])('observer rejects runtime %s with version %s and pin %s', (runtime, line, cliPin) => {
  const f = fixture(line!);
  try {
    expect(() =>
      prepareObserverAfterSetup({ ...f.args, runtime: runtime!, cliPin }),
    ).toThrow(
      'Required observer dialect/build lacks exact inspected provenance.',
    );
    expect(
      existsSync(join(f.args.runDir, 'gauntlet-agent/observer-binding.json')),
    ).toBe(false);
    expect(existsSync(f.args.home)).toBe(false);
    f.assertProbeCleaned();
  } finally {
    f.cleanup();
  }
});
