import { expect, test } from 'bun:test';
import {
  APP_SERVER_STDIN_GRACE_SECONDS,
  buildAppServerSpawnArgv,
  buildHandshakeInput,
  parseAppServerResponse,
} from '../src/agents/codex-app-server.ts';
import { ProvisionError } from '../src/agents/index.ts';

// The two JSON-RPC requests piped to `codex app-server`: initialize (id 1) then
// hooks/list (id 2). The shape is grounded in the codex source
// (app-server-protocol/src/protocol/v1.rs InitializeParams: clientInfo +
// capabilities.experimentalApi; protocol/common.rs HooksList => "hooks/list"
// with v2::HooksListParams { cwds }).
test('buildHandshakeInput emits initialize (id1) then hooks/list (id2)', () => {
  const input = buildHandshakeInput('/run/workdir');
  const lines = input
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  expect(lines).toHaveLength(2);

  const [initialize, hooksList] = lines;
  expect(initialize.id).toBe(1);
  expect(initialize.method).toBe('initialize');
  // codex enables experimental API off capabilities.experimentalApi (camelCase
  // of InitializeCapabilities.experimental_api in v1.rs).
  expect(initialize.params.capabilities.experimentalApi).toBe(true);
  expect(initialize.params.clientInfo.name).toBeString();

  expect(hooksList.id).toBe(2);
  expect(hooksList.method).toBe('hooks/list');
  expect(hooksList.params.cwds).toEqual(['/run/workdir']);
});

// The crux of the 0.133.0 fix: spawnSync writes `input` to the child's stdin and
// then closes it. The stdio transport (app-server-transport/src/transport/
// stdio.rs:50-79) treats that EOF as ConnectionClosed, and the stdio path runs
// in single_client_mode (lib.rs:631) where shutdown_when_no_connections tears
// the process down (lib.rs:878) BEFORE the async hooks/list response is flushed.
// So the spawn must keep codex's stdin pipe OPEN for a grace window after the
// requests are written. The argv wraps the codex invocation in a shell that
// relays our stdin (cat) then holds the pipe open (sleep) before EOF.
test('buildAppServerSpawnArgv holds codex stdin open past EOF', () => {
  const { command, args } = buildAppServerSpawnArgv();
  expect(command).toBe('sh');
  expect(args[0]).toBe('-c');
  const script = args[1] ?? '';
  // relays our requests to codex, then holds the pipe open for the grace.
  expect(script).toContain('cat');
  expect(script).toContain(`sleep ${APP_SERVER_STDIN_GRACE_SECONDS}`);
  expect(script).toContain('codex app-server --listen stdio://');
  // The grace must be positive (a zero/absent grace reintroduces the EOF race)
  // and comfortably under the 15s handshake deadline.
  expect(APP_SERVER_STDIN_GRACE_SECONDS).toBeGreaterThan(0);
  expect(APP_SERVER_STDIN_GRACE_SECONDS).toBeLessThan(15);
});

// parseAppServerResponse scans newline-delimited JSON-RPC for the id-N response.
test('parseAppServerResponse returns the matching id-2 response', () => {
  const stdout = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    JSON.stringify({ method: 'remoteControl/status/changed', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { data: [] } }),
  ].join('\n');
  const response = parseAppServerResponse(stdout, 2);
  expect(response.result?.data).toEqual([]);
});

test('parseAppServerResponse surfaces an id-2 error payload', () => {
  const stdout = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32600, message: 'Not initialized' },
    }),
  ].join('\n');
  expect(() => parseAppServerResponse(stdout, 2)).toThrow(ProvisionError);
  expect(() => parseAppServerResponse(stdout, 2)).toThrow(/Not initialized/);
});

test('parseAppServerResponse throws when the id is absent (the live symptom)', () => {
  // Only the initialize response made it out before the EOF-driven shutdown ate
  // the hooks/list response — this is exactly the "no response for request 2"
  // failure the grace window prevents.
  const stdout = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
  expect(() => parseAppServerResponse(stdout, 2)).toThrow(
    /no response for request 2/,
  );
});
