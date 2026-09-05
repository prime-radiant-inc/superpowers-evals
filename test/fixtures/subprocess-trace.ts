import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getEnv } from '../../src/env.ts';

// Opt-in test evidence lives outside fixture Git trees, run homes and artifacts.
// Failure to retain diagnostics must never replace the command's own outcome.
export function subprocessTraceDir(label: string): string | undefined {
  const root = getEnv('QUORUM_TEST_TRACE_ROOT');
  if (root === undefined || !isAbsolute(root)) return undefined;
  try {
    mkdirSync(root, { recursive: true });
    return mkdtempSync(join(root, `${label}-`));
  } catch {
    return undefined;
  }
}

export function writeSubprocessTrace(
  dir: string | undefined,
  record: Readonly<Record<string, unknown>>,
): void {
  if (dir === undefined) return;
  try {
    appendFileSync(
      join(dir, 'calls.jsonl'),
      `${JSON.stringify({ at_ms: Date.now(), ...record })}\n`,
    );
  } catch {
    // Diagnostics are best effort; the delegated operation retains authority.
  }
}

export function traceError(
  error: unknown,
): { code?: string; message: string } | undefined {
  if (error === undefined) return undefined;
  if (!(error instanceof Error)) return { message: String(error) };
  const code = (error as NodeJS.ErrnoException).code;
  return { ...(code === undefined ? {} : { code }), message: error.message };
}
