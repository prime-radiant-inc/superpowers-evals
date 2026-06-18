import { writeFileSync } from 'node:fs';
import { buildGridManifest } from './matrix.ts';

export function writeGridManifest(args: {
  scenariosRoot: string;
  codingAgentsDir: string;
  outPath: string;
  now: string;
}): void {
  const manifest = buildGridManifest(
    {
      scenariosRoot: args.scenariosRoot,
      codingAgentsDir: args.codingAgentsDir,
    },
    args.now,
  );
  writeFileSync(args.outPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
