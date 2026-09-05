import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteProcessEnv, envSnapshot } from '../src/env.ts';

// Bun reads ancestor directories at startup. Avoid inherited app temp trees
// with large accumulated fixture inventories, and keep uninitialized fixtures
// outside Git checkouts. Each invocation owns a separate temporary directory.
const env = { ...envSnapshot() };
const tempVariables = ['TMPDIR', 'TMP', 'TEMP'] as const;
for (const name of tempVariables) deleteProcessEnv(name);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'quorum-tests-')));
for (const name of tempVariables) env[name] = root;

const args = process.argv.slice(2);
let successful = false;
try {
  const child = Bun.spawn(
    [process.execPath, 'test', ...(args.length === 0 ? ['test/'] : args)],
    { env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
  );
  let cancellationExitCode: number | undefined;
  const cancel = (signal: 'SIGINT' | 'SIGTERM', code: number) => {
    cancellationExitCode ??= code;
    child.kill(signal);
  };
  const interrupt = () => cancel('SIGINT', 130);
  const terminate = () => cancel('SIGTERM', 143);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    process.exitCode = (await child.exited) || cancellationExitCode || 0;
    successful = process.exitCode === 0;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
} finally {
  if (successful) {
    rmSync(root, { recursive: true, force: true });
  } else {
    process.stderr.write(`Test temporary files retained at ${root}\n`);
  }
}
