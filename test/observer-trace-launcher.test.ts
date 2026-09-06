import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateObserverBinding } from '../src/experiments/observer/binding.ts';
import {
  buildContextSubstitutions,
  prepareObserverAfterSetup,
} from '../src/runner/index.ts';

test.each([
  true,
  false,
])('production env-i Codex launcher includes private trace root only for a required observer (%s)', (required) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trace-launcher-')));
  try {
    const home = join(dir, 'home'),
      workdir = join(dir, 'workdir'),
      bin = join(dir, 'bin');
    for (const path of [home, workdir, bin]) mkdirSync(path);
    const codex = join(bin, 'codex');
    writeFileSync(
      codex,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.146.0"; else /usr/bin/env; fi\n',
    );
    chmodSync(codex, 0o700);
    prepareObserverAfterSetup({
      scenario: required ? 'brainstorming-todo-shared-intent' : 'unrelated',
      runDir: dir,
      home,
      workdir,
      runtime: 'codex',
      binary: codex,
      campaign: null,
    });
    const observerBinding = required
      ? validateObserverBinding(
          JSON.parse(
            readFileSync(
              join(dir, 'gauntlet-agent/observer-binding.json'),
              'utf8',
            ),
          ),
        )
      : undefined;
    const launcher = join(dir, 'launch-agent');
    const substitutions = {
      ...buildContextSubstitutions({
        launchCwd: workdir,
        launchAgentPath: launcher,
        runHomeDir: home,
        family: 'codex',
        observerBinding,
      }),
      $CODEX_ENV_FILE: join(dir, 'absent.env'),
    };
    let script = readFileSync(
      resolve(import.meta.dir, '../coding-agents/codex-context/launch-agent'),
      'utf8',
    );
    for (const [key, value] of Object.entries(substitutions).sort(
      ([a], [b]) => b.length - a.length,
    ))
      script = script.replaceAll(key, value);
    writeFileSync(launcher, script);
    chmodSync(launcher, 0o700);
    const output = spawnSync(launcher, [], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        CODEX_ROLLOUT_TRACE_ROOT: '/host/should-not-leak',
      },
      encoding: 'utf8',
    });
    expect(output.status).toBe(0);
    const env = Object.fromEntries(
      output.stdout
        .trim()
        .split('\n')
        .map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    expect(env['CODEX_ROLLOUT_TRACE_ROOT'] ?? null).toBe(
      required ? join(home, '.codex/rollout-traces') : null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
