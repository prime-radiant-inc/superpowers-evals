import { expect, test } from 'bun:test';
import {
  type AppServerSpawn,
  type AppServerSpawnResult,
  SpawnAppServerClient,
} from '../src/agents/codex-app-server.ts';
import { ProvisionError } from '../src/agents/index.ts';

// A canned hooks/list response (id 2) carrying one superpowers@debug
// SessionStart hook the selector accepts, plus the id-1 initialize ack.
function happyStdout(): string {
  const init = { jsonrpc: '2.0', id: 1, result: {} };
  const hooks = {
    jsonrpc: '2.0',
    id: 2,
    result: {
      data: [
        {
          hooks: [
            {
              pluginId: 'superpowers@debug',
              source: 'plugin',
              eventName: 'sessionStart',
              matcher: 'startup|clear|compact',
              command: 'bash .claude/hooks/run-hook.cmd session-start',
              trustStatus: 'untrusted',
              key: 'superpowers@debug:sessionStart',
              currentHash: 'deadbeef',
            },
          ],
        },
      ],
    },
  };
  return `${JSON.stringify(init)}\n${JSON.stringify(hooks)}\n`;
}

// A spawn double recording the timeout it was handed and returning a canned
// result, so the test can assert the per-handshake deadline reaches spawnSync.
function fakeSpawn(result: AppServerSpawnResult): {
  spawn: AppServerSpawn;
  lastTimeout: () => number | undefined;
} {
  let seen: number | undefined;
  return {
    spawn: (_command, _args, options) => {
      seen = options.timeout;
      return result;
    },
    lastTimeout: () => seen,
  };
}

test('readHook returns the selected hook on a clean handshake', () => {
  const { spawn, lastTimeout } = fakeSpawn({
    status: 0,
    stdout: happyStdout(),
    stderr: '',
    timedOut: false,
  });
  const client = new SpawnAppServerClient(spawn);
  const hook = client.readHook({
    configDir: '/tmp/cfg',
    workdir: '/tmp/wd',
    timeoutMs: 15_000,
  });
  expect(hook).toEqual({
    key: 'superpowers@debug:sessionStart',
    currentHash: 'deadbeef',
  });
  // The per-handshake deadline reached the spawn (no infinite block).
  expect(lastTimeout()).toBe(15_000);
});

test('readHook raises a diagnostic ProvisionError when the app-server times out', () => {
  const { spawn } = fakeSpawn({
    status: null,
    stdout: '',
    stderr: 'still booting',
    timedOut: true,
  });
  const client = new SpawnAppServerClient(spawn);
  expect(() =>
    client.readHook({
      configDir: '/tmp/cfg',
      workdir: '/tmp/wd',
      timeoutMs: 50,
    }),
  ).toThrow(/[Tt]imed out/);
  // The stderr detail is preserved for triage.
  expect(() =>
    client.readHook({
      configDir: '/tmp/cfg',
      workdir: '/tmp/wd',
      timeoutMs: 50,
    }),
  ).toThrow(/still booting/);
});

test('readHook raises ProvisionError on a non-zero, non-timeout exit', () => {
  const { spawn } = fakeSpawn({
    status: 2,
    stdout: '',
    stderr: 'boom',
    timedOut: false,
  });
  const client = new SpawnAppServerClient(spawn);
  expect(() =>
    client.readHook({
      configDir: '/tmp/cfg',
      workdir: '/tmp/wd',
      timeoutMs: 50,
    }),
  ).toThrow(ProvisionError);
});
