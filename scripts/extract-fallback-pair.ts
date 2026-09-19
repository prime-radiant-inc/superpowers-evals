import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

type Label = 'original' | 'tentative';

interface ExtractFallbackResult {
  readonly labels: Record<'A' | 'B', Label>;
}

export function extractFallbackPair(
  runDir: string,
  originalPath: string,
  tentativePath: string,
  selectedPath: string,
  outDir: string,
  random: () => number = Math.random,
): ExtractFallbackResult {
  const workdir = join(runDir, 'coding-agent-workdir');
  const original = readFileSync(join(workdir, originalPath), 'utf8');
  const tentative = readFileSync(join(workdir, tentativePath), 'utf8');
  const labels: Record<'A' | 'B', Label> =
    random() < 0.5
      ? { A: 'original', B: 'tentative' }
      : { A: 'tentative', B: 'original' };
  const artifacts: Record<Label, string> = { original, tentative };
  const excluded = new Set([originalPath, tentativePath, selectedPath]);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'A.md'), artifacts[labels.A]);
  writeFileSync(join(outDir, 'B.md'), artifacts[labels.B]);
  writeFileSync(
    join(outDir, 'manifest.json'),
    `${JSON.stringify(
      { originalPath, tentativePath, selectedPath, labels },
      null,
      2,
    )}\n`,
  );
  cpSync(workdir, join(outDir, 'repository'), {
    recursive: true,
    filter: (source) => {
      const path = relative(workdir, source).replaceAll('\\', '/');
      return !excluded.has(path) && path !== '.git' && !path.startsWith('.git/');
    },
  });
  return { labels };
}

if (import.meta.main) {
  const [runDir, originalPath, tentativePath, selectedPath, outDir] =
    process.argv.slice(2);
  if (!runDir || !originalPath || !tentativePath || !selectedPath || !outDir) {
    throw new Error(
      'usage: extract-fallback-pair <run-dir> <original> <tentative> <selected> <out-dir>',
    );
  }
  extractFallbackPair(runDir, originalPath, tentativePath, selectedPath, outDir);
}
