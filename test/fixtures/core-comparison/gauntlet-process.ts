import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeGauntlet } from '../../../src/runner/index.ts';

/** Harmless local child: exercise the actual spawn/close/result producer. */
export async function gauntletProcessExit(args: {
  code?: number;
  signal?: 'SIGABRT' | 'SIGTERM';
  result?: 'pass' | 'fail' | 'investigate' | 'errored';
}) {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-process-'));
  try {
    if (args.result) {
      const dir = join(root, 'gauntlet-agent/results/result');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'result.json'),
        JSON.stringify({ status: args.result, summary: '', reasoning: '' }),
      );
    }
    const binary = join(root, 'gauntlet');
    writeFileSync(
      binary,
      `#!/bin/sh\nulimit -c 0\n${args.signal ? `kill -s ${args.signal.slice(3)} $$` : `exit ${args.code ?? 0}`}\n`,
    );
    chmodSync(binary, 0o755);
    return (
      await invokeGauntlet({
        storyPath: join(root, 'story.md'),
        targetBinary: 'unused',
        runDir: root,
        launchCwd: root,
        runHomeDir: root,
        envBase: {},
        gauntletBin: binary,
      })
    ).gauntlet;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
