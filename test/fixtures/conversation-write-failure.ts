// Run filesystem fault injection in a separate process so module mocks cannot
// affect other runner tests or the real Gauntlet fixture child.
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { PreparedConversation } from '../../src/runner/conversation.ts';

const args = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as Omit<
  PreparedConversation,
  'snapshot' | 'shouldStop'
>;
const mode = process.argv[3];
const completionPath = join(args.runDir, 'conversation.json');
const originalWrite = fs.writeFileSync;
const originalRead = fs.readFileSync;
const originalRename = fs.renameSync;
const originalExists = fs.existsSync;
let observedCompletion: string | null = null;
let faultCount = 0;
function observeCompletion() {
  try {
    const bytes = originalRead(completionPath, 'utf8');
    if (JSON.parse(bytes).status === 'completed') observedCompletion ??= bytes;
  } catch {
    /* The child has not persisted completion yet. */
  }
}
function storageError() {
  faultCount++;
  return Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
}
mock.module('node:fs', () => ({
  ...fs,
  writeFileSync(...params: Parameters<typeof fs.writeFileSync>) {
    observeCompletion();
    const path = String(params[0]);
    if (
      path === completionPath ||
      (mode === 'fallback-write' &&
        dirname(path) === args.runDir &&
        basename(path).includes('conversation'))
    ) {
      originalWrite(params[0], '{');
      throw storageError();
    }
    if (
      mode === 'error' &&
      path === join(args.runDir, 'evidence/conversation.json')
    ) {
      originalWrite(params[0], '{');
      throw storageError();
    }
    return originalWrite(...params);
  },
  renameSync(...params: Parameters<typeof fs.renameSync>) {
    if (mode === 'fallback-rename' && String(params[1]) === completionPath)
      throw storageError();
    return originalRename(...params);
  },
}));
const { runPreparedConversation } = await import(
  '../../src/runner/conversation.ts'
);
const { currentRoleChild } = await import('../../src/runner/gauntlet-role.ts');
let verdict: Awaited<ReturnType<typeof runPreparedConversation>> | undefined;
let escaped: string | null = null;
try {
  verdict = await runPreparedConversation({
    ...args,
    snapshot: new Set(),
    shouldStop: () => {
      observeCompletion();
      return (
        mode === 'cancel' &&
        observedCompletion !== null &&
        currentRoleChild() === null
      );
    },
  });
} catch (error) {
  escaped = String(error);
}
process.stdout.write(
  JSON.stringify({
    verdict,
    escaped,
    observedCompletion,
    faultCount,
    durableBytes: originalExists(completionPath)
      ? originalRead(completionPath, 'utf8')
      : null,
    rootFiles: fs.readdirSync(args.runDir),
  }),
);
