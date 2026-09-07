import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEnv } from '../src/env.ts';
import {
  currentRoleChild,
  invokeGauntletRole,
} from '../src/runner/gauntlet-role.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const runDir = mkdtempSync(join(tmpdir(), 'role-'));
  dirs.push(runDir);
  const record = {
    out_dir: 'role',
    model: 'offline',
    started_at: null,
    finished_at: null,
    process_exit: null,
    stop_cause: null,
  };
  writeFileSync(
    join(runDir, 'gauntlet-roles.json'),
    JSON.stringify({
      conversation: record,
      assessment: { ...record, out_dir: 'assessment' },
    }),
  );
  return {
    role: 'conversation' as const,
    binary: process.execPath,
    argv: ['-e', 'setInterval(() => {}, 1000)'],
    runDir,
    env: { PATH: getEnv('PATH') },
    deadlineMs: 150,
    shouldStop: () => false,
  };
}
test('parent deadline settles a hung role and persists its actual exit', async () => {
  const args = setup();
  const start = Date.now();
  const result = await invokeGauntletRole(args);
  expect(Date.now() - start).toBeLessThan(2000);
  expect(result.stop_cause).toBe('timed_out');
  expect(result.process_exit?.signal).toBeTruthy();
  expect(result.started_at).not.toBeNull();
  expect(result.finished_at).not.toBeNull();
  expect(currentRoleChild()).toBeNull();
  expect(
    JSON.parse(readFileSync(join(args.runDir, 'gauntlet-roles.json'), 'utf8'))
      .conversation,
  ).toEqual(result);
});
test('cancel removes only the supplied private tmux server', async () => {
  const args = setup();
  const socketPath = join(args.runDir, 'owned');
  const other = join(args.runDir, 'other');
  for (const socket of [socketPath, other])
    expect(
      spawnSync('tmux', ['-S', socket, 'new-session', '-d', 'sleep 30']).status,
    ).toBe(0);
  let stopped = false;
  const timer = setTimeout(() => {
    stopped = true;
  }, 150);
  try {
    const result = await invokeGauntletRole({
      ...args,
      deadlineMs: 1500,
      socketPath,
      shouldStop: () => stopped,
    });
    expect(result.stop_cause).toBe('cancelled');
    expect(
      spawnSync('tmux', ['-S', socketPath, 'list-sessions']).status,
    ).not.toBe(0);
    expect(spawnSync('tmux', ['-S', other, 'list-sessions']).status).toBe(0);
  } finally {
    clearTimeout(timer);
    spawnSync('tmux', ['-S', other, 'kill-server']);
  }
});

test('timeout kills a known pane group even if its server disappeared first', async () => {
  const args = setup();
  const socketPath = join(args.runDir, 'owned');
  const pidFile = join(args.runDir, 'subject.pid');
  const subject = join(args.runDir, 'subject.sh');
  writeFileSync(
    subject,
    `#!/bin/sh\ntrap '' HUP TERM\necho $$ > '${pidFile}'\nwhile :; do sleep 1; done\n`,
  );
  expect(
    spawnSync('tmux', [
      '-S',
      socketPath,
      'new-session',
      '-d',
      `sh '${subject}'`,
    ]).status,
  ).toBe(0);
  await Bun.sleep(80);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const disappear = setTimeout(() => {
    spawnSync('tmux', ['-S', socketPath, 'kill-server']);
  }, 70);
  try {
    const result = await invokeGauntletRole({
      ...args,
      socketPath,
      deadlineMs: 250,
    });
    expect(result.stop_cause).toBe('timed_out');
    await Bun.sleep(80);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    clearTimeout(disappear);
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
});
test('a nonzero role exit terminates its still-running private subject', async () => {
  const args = setup();
  const socketPath = join(args.runDir, 'owned');
  expect(
    spawnSync('tmux', ['-S', socketPath, 'new-session', '-d', 'sleep 30'])
      .status,
  ).toBe(0);
  const result = await invokeGauntletRole({
    ...args,
    argv: ['-e', 'process.exit(7)'],
    socketPath,
  });
  expect(result.process_exit?.code).toBe(7);
  expect(
    spawnSync('tmux', ['-S', socketPath, 'list-sessions']).status,
  ).not.toBe(0);
});

test('a zero role exit cannot confirm shutdown while its known pane group survives', async () => {
  const args = setup();
  const socketPath = join(args.runDir, 'owned');
  const subject = join(args.runDir, 'subject.sh');
  writeFileSync(
    subject,
    "#!/bin/sh\ntrap '' HUP TERM\nwhile :; do sleep 1; done\n",
  );
  expect(
    spawnSync('tmux', [
      '-S',
      socketPath,
      'new-session',
      '-d',
      `sh '${subject}'`,
    ]).status,
  ).toBe(0);
  await Bun.sleep(50);
  const group = Number(
    spawnSync('tmux', ['-S', socketPath, 'list-panes', '-F', '#{pane_pid}'], {
      encoding: 'utf8',
    }).stdout.trim(),
  );
  const argv = [
    '-e',
    `await Bun.sleep(70); Bun.spawnSync(['tmux', '-S', ${JSON.stringify(socketPath)}, 'kill-server']); await Bun.sleep(30); require('node:fs').rmSync(${JSON.stringify(socketPath)}, { force: true });`,
  ];
  try {
    await expect(
      invokeGauntletRole({ ...args, argv, socketPath, deadlineMs: 1000 }),
    ).rejects.toThrow('runtime');
  } finally {
    try {
      process.kill(-group, 'SIGKILL');
    } catch {}
  }
});

test('a failed spawn leaves the allocated role unstarted', async () => {
  const args = setup();
  await expect(
    invokeGauntletRole({ ...args, binary: join(args.runDir, 'absent') }),
  ).rejects.toThrow();
  const role = JSON.parse(
    readFileSync(join(args.runDir, 'gauntlet-roles.json'), 'utf8'),
  ).conversation;
  expect(role.started_at).toBeNull();
  expect(role.process_exit).toBeNull();
  expect(currentRoleChild()).toBeNull();
});

test('a closed private server can leave a socket inode after a clean role exit', async () => {
  const args = setup();
  const socketPath = join(args.runDir, 'owned');
  expect(
    spawnSync('tmux', ['-S', socketPath, 'new-session', '-d', 'sleep 30'])
      .status,
  ).toBe(0);
  try {
    const result = await invokeGauntletRole({
      ...args,
      socketPath,
      deadlineMs: 1000,
      argv: [
        '-e',
        `await Bun.sleep(70); Bun.spawnSync(['tmux', '-S', ${JSON.stringify(socketPath)}, 'kill-server']); await Bun.sleep(70);`,
      ],
    });
    expect(result.process_exit?.code).toBe(0);
    expect(
      spawnSync('tmux', ['-S', socketPath, 'list-sessions']).status,
    ).not.toBe(0);
  } finally {
    spawnSync('tmux', ['-S', socketPath, 'kill-server']);
  }
});
