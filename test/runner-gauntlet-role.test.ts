import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcesses from 'node:child_process';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
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
      assessment: { ...record, out_dir: 'demo_20260909T120000Z_ab12' },
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
test('conversation retains its existing allowance after a slow spawn', async () => {
  const original = childProcesses.spawn;
  const spy = spyOn(childProcesses, 'spawn').mockImplementation(((
    ...args: Parameters<typeof childProcesses.spawn>
  ) => {
    const child = original(...args);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    return child;
  }) as typeof childProcesses.spawn);
  try {
    const start = performance.now();
    const result = await invokeGauntletRole(setup());
    expect(result.stop_cause).toBe('timed_out');
    expect(performance.now() - start).toBeGreaterThanOrEqual(340);
  } finally {
    spy.mockRestore();
  }
});
for (const role of ['conversation', 'assessment'] as const)
  test(`parent deadline settles a hung ${role}`, async () => {
    const args = { ...setup(), role };
    const start = Date.now();
    const result = await invokeGauntletRole(args);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(result.stop_cause).toBe('timed_out');
    expect(result.process_exit?.signal).toBeTruthy();
    expect(result.started_at).not.toBeNull();
    expect(result.finished_at).not.toBeNull();
    expect(currentRoleChild()).toBeNull();
    const records = JSON.parse(
      readFileSync(join(args.runDir, 'gauntlet-roles.json'), 'utf8'),
    );
    expect(records[role]).toEqual(result);
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
    // This test checks exit/cleanup, not a deadline; allow host scheduling.
    deadlineMs: 1500,
  });
  expect(result.process_exit?.code).toBe(7);
  expect(
    spawnSync('tmux', ['-S', socketPath, 'list-sessions']).status,
  ).not.toBe(0);
});

function assessmentChild(
  options: {
    status?: string;
    exit?: number;
    missing?: boolean;
    wait?: boolean;
  } = {},
) {
  const args = setup();
  const script = join(args.runDir, 'child.ts');
  writeFileSync(
    script,
    `
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
const id = 'demo_20260909T120000Z_ab12';
mkdirSync(id);
writeFileSync('argv.json', JSON.stringify(process.argv));
const result = JSON.stringify({ runId:id, scenario:'demo', status:'pass', summary:'Assessed', reasoning:'Evidence', criteria:[{criterion:'Works',verdict:'pass',evidence:'a.ts'}] });
writeFileSync(id+'/result.json', result);
const status = ${JSON.stringify(options.status ?? 'completed')};
${options.missing ? '' : `writeFileSync(id+'/assessment-completion.json', JSON.stringify({schema_version:1,run_id:id,status,reason:'Decision',terminal_at:new Date().toISOString(),accepted_report_sha256:status==='completed'?createHash('sha256').update(result).digest('hex'):null}));`}
${options.wait ? "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);" : `process.exit(${options.exit ?? 0});`}
`,
  );
  return {
    ...args,
    role: 'assessment' as const,
    argv: [script],
    deadlineMs: 1500,
  };
}
test('assessment inherits the exact parent start/deadline and completes after settlement', async () => {
  const args = assessmentChild();
  const result = await invokeGauntletRole(args);
  const argv = JSON.parse(
    readFileSync(join(args.runDir, 'argv.json'), 'utf8'),
  ) as string[];
  expect(Number(argv[argv.indexOf('--hard-deadline-at-ms') + 1])).toBe(
    Date.parse(result.started_at!) + 1500,
  );
  expect(result.process_exit).toEqual({ code: 0, signal: null });
  expect(result.stop_cause).toBeNull();
});
for (const flag of ['--hard-deadline-at-ms', '--hard-deadline-at-ms=1'])
  test(`rejects supplied inherited deadline ${flag}`, async () => {
    const args = assessmentChild();
    await expect(
      invokeGauntletRole({ ...args, argv: [...args.argv, flag, '1'] }),
    ).rejects.toThrow('deadline');
    expect(fs.existsSync(join(args.runDir, 'argv.json'))).toBe(false);
  });
test('valid child cooperative timeout supplies the parent stop', async () => {
  const result = await invokeGauntletRole(
    assessmentChild({ status: 'timed_out', exit: 1 }),
  );
  expect(result.stop_cause).toBe('timed_out');
  expect(result.process_exit?.code).toBe(1);
});
test('parent cancellation wins over a completed marker', async () => {
  const args = assessmentChild({ wait: true });
  const result = await invokeGauntletRole({
    ...args,
    shouldStop: () => fs.existsSync(join(args.runDir, 'argv.json')),
  });
  expect(result.stop_cause).toBe('cancelled');
});
for (const code of [0, 1])
  test(`missing marker rejects settled exit ${code} and retains its record`, async () => {
    const args = assessmentChild({ missing: true, exit: code });
    await expect(invokeGauntletRole(args)).rejects.toThrow();
    expect(
      JSON.parse(readFileSync(join(args.runDir, 'gauntlet-roles.json'), 'utf8'))
        .assessment.process_exit,
    ).toEqual({ code, signal: null });
  });
test('operational exit 2 rejects otherwise matching completed evidence', async () => {
  await expect(
    invokeGauntletRole(assessmentChild({ exit: 2 })),
  ).rejects.toThrow();
});
test('hard deadline still wins when marker validation blocks the event loop after exit', async () => {
  const args = assessmentChild();
  const original = fs.readFileSync;
  let readMarker = false;
  const spy = spyOn(fs, 'readFileSync').mockImplementation(((
    ...input: Parameters<typeof fs.readFileSync>
  ) => {
    if (String(input[0]).endsWith('assessment-completion.json')) {
      readMarker = true;
      const started = JSON.parse(
        original(join(args.runDir, 'gauntlet-roles.json'), 'utf8'),
      ).assessment.started_at;
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.max(0, Date.parse(started) + args.deadlineMs - Date.now()) + 30,
      );
    }
    return original(...input);
  }) as typeof fs.readFileSync);
  try {
    const result = await invokeGauntletRole(args);
    expect(readMarker).toBe(true);
    expect(result.process_exit?.code).toBe(0);
    expect(result.stop_cause).toBe('timed_out');
    expect(
      JSON.parse(original(join(args.runDir, 'gauntlet-roles.json'), 'utf8'))
        .assessment.stop_cause,
    ).toBe('timed_out');
  } finally {
    spy.mockRestore();
  }
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

test('cancelling the outer driver kills a HUP/TERM-resistant subject descendant and preserves another server', async () => {
  const args = setup();
  const socketPath = join(args.runDir, 'owned');
  const other = join(args.runDir, 'other');
  const pidFile = join(args.runDir, 'descendant.pid');
  const descendant = join(args.runDir, 'descendant.sh');
  const subject = join(args.runDir, 'subject.sh');
  writeFileSync(
    descendant,
    `trap '' HUP TERM\necho $$ > '${pidFile}'\nwhile :; do sleep 1; done\n`,
  );
  writeFileSync(
    subject,
    `trap '' HUP TERM\nsh '${descendant}' &\nwait\nwhile :; do sleep 1; done\n`,
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
  expect(
    spawnSync('tmux', ['-S', other, 'new-session', '-d', 'sleep 30']).status,
  ).toBe(0);
  await Bun.sleep(80);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const cancel = setTimeout(() => currentRoleChild()?.kill('SIGTERM'), 150);
  try {
    const result = await invokeGauntletRole({
      ...args,
      socketPath,
      deadlineMs: 1500,
    });
    expect(result.process_exit?.signal).toBe('SIGTERM');
    await Bun.sleep(80);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(
      spawnSync('tmux', ['-S', socketPath, 'list-sessions']).status,
    ).not.toBe(0);
    expect(spawnSync('tmux', ['-S', other, 'list-sessions']).status).toBe(0);
  } finally {
    clearTimeout(cancel);
    spawnSync('tmux', ['-S', other, 'kill-server']);
    spawnSync('tmux', ['-S', socketPath, 'kill-server']);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
});
