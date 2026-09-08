import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AtifTrajectory } from '../../src/atif/types.ts';
import { normalizePi } from '../../src/normalize/pi.ts';
import { estimateTrajectory } from '../../src/obol/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'pi-obol-pricing-'));

function piTrajectory(
  model: string,
  input: number,
  output: number,
): AtifTrajectory {
  return normalizePi(
    [
      JSON.stringify({ type: 'session', id: `session-${model}`, cwd: '/tmp' }),
      JSON.stringify({
        type: 'model_change',
        provider: 'quorum',
        modelId: model,
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-09-08T19:33:32.640Z',
        message: {
          role: 'assistant',
          provider: 'quorum',
          model,
          usage: {
            input,
            output,
            cacheRead: model === 'gpt-5.6-sol' ? 1000 : 0,
            cacheWrite: model === 'gpt-5.6-sol' ? 1000 : 0,
            cost: { total: 0 },
          },
          content: [{ type: 'text', text: 'done' }],
        },
      }),
    ].join('\n'),
    '0.80.7',
  );
}

async function price(trajectory: AtifTrajectory, name: string) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(trajectory)}\n`);
  return estimateTrajectory(path);
}

try {
  const known = await price(
    piTrajectory('gpt-5.6-sol', 1000, 1000),
    'known.json',
  );
  const unknown = await price(
    piTrajectory('unknown-pi-model', 50, 10),
    'unknown.json',
  );
  process.stdout.write(JSON.stringify({ known, unknown }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
