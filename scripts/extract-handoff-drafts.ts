import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';

type Label = 'initial' | 'final';

interface ExtractResult {
  readonly labels: Record<'A' | 'B', Label>;
}

function firstAddedFile(trajectory: unknown, targetBasename: string): string {
  const steps = (trajectory as { steps?: unknown[] }).steps ?? [];
  for (const step of steps) {
    const calls = (step as { tool_calls?: unknown[] }).tool_calls ?? [];
    for (const call of calls) {
      const args = (call as { arguments?: Record<string, unknown> }).arguments;
      if (!args) continue;
      const filePath = String(args['file_path'] ?? '');
      const patch = String(args['patch'] ?? '');
      if (basename(filePath) !== targetBasename || !patch.includes('*** Add File:')) {
        continue;
      }
      const body = patch.slice(patch.indexOf('*** Add File:')).split('\n').slice(1);
      const added: string[] = [];
      for (const line of body) {
        if (line.startsWith('*** End Patch')) break;
        if (line.startsWith('+')) added.push(line.slice(1));
      }
      if (added.length > 0) return `${added.join('\n')}\n`;
    }
  }
  throw new Error(`no initial Add File patch found for ${targetBasename}`);
}

export function extractHandoffDrafts(
  runDir: string,
  specPath: string,
  outDir: string,
  random: () => number = Math.random,
): ExtractResult {
  const trajectory = JSON.parse(
    readFileSync(join(runDir, 'trajectory.json'), 'utf8'),
  );
  const initial = firstAddedFile(trajectory, basename(specPath));
  const final = readFileSync(join(runDir, 'coding-agent-workdir', specPath), 'utf8');
  const labels: Record<'A' | 'B', Label> =
    random() < 0.5
      ? { A: 'initial', B: 'final' }
      : { A: 'final', B: 'initial' };
  const artifacts: Record<Label, string> = { initial, final };
  const workdir = join(runDir, 'coding-agent-workdir');

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'A.md'), artifacts[labels.A]);
  writeFileSync(join(outDir, 'B.md'), artifacts[labels.B]);
  writeFileSync(
    join(outDir, 'manifest.json'),
    `${JSON.stringify({ specPath, labels }, null, 2)}\n`,
  );
  cpSync(workdir, join(outDir, 'repository'), {
    recursive: true,
    filter: (source) => {
      const path = relative(workdir, source).replaceAll('\\', '/');
      return path !== specPath && path !== '.git' && !path.startsWith('.git/');
    },
  });
  return { labels };
}

if (import.meta.main) {
  const [runDir, specPath, outDir] = process.argv.slice(2);
  if (!runDir || !specPath || !outDir) {
    throw new Error('usage: extract-handoff-drafts <run-dir> <spec-path> <out-dir>');
  }
  extractHandoffDrafts(runDir, specPath, outDir);
}
