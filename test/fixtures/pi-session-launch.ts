import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getEnv } from '../../src/env.ts';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('pi 0.0-test\n');
  process.exit(0);
}

const sessionDirFlag = args.indexOf('--session-dir');
const suppliedSessionDir =
  sessionDirFlag === -1 ? undefined : args[sessionDirFlag + 1];
const encoded = `--${resolve(process.cwd())
  .replace(/^[/\\]/, '')
  .replace(/[/\\:]/g, '-')}--`;
const sessionDir =
  suppliedSessionDir ??
  join(getEnv('HOME') as string, '.pi/agent/sessions', encoded);

mkdirSync(sessionDir, { recursive: true });
mkdirSync(join(sessionDir, 'nested'), { recursive: true });

const raw = readFileSync(
  join(import.meta.dir, 'pi-session.slice.jsonl'),
  'utf8',
);
const [header, ...sourceRows] = raw.trimEnd().split('\n');
const rows = sourceRows.map((line) => {
  const row = JSON.parse(line);
  if (row.type === 'model_change') {
    row.provider = getEnv('PI_PROVIDER');
    row.modelId = getEnv('PI_MODEL');
  }
  if (row.message?.role === 'assistant') {
    row.message.provider = getEnv('PI_PROVIDER');
    row.message.model = getEnv('PI_MODEL');
    if (row.message.usage) row.message.usage.cost = { total: 0 };
  }
  return JSON.stringify(row);
});

function writeSession(path: string, cwd: string): void {
  const session = JSON.parse(header as string);
  session.cwd = cwd;
  writeFileSync(path, `${[JSON.stringify(session), ...rows].join('\n')}\n`);
}

writeSession(join(sessionDir, 'session.jsonl'), process.cwd());
writeSession(join(sessionDir, 'nested', 'child.jsonl'), process.cwd());
writeSession(join(sessionDir, 'wrong-cwd.jsonl'), resolve(process.cwd(), '..'));
writeFileSync('pi-launch-argv.txt', `${args.join('\n')}\n`);
writeFileSync(
  'pi-launch-model.txt',
  `${getEnv('PI_PROVIDER')}/${getEnv('PI_MODEL')}\n`,
);
writeFileSync('pi-session-dir.txt', `${sessionDir}\n`);
