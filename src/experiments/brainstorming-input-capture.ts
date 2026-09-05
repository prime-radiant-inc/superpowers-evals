// Scenario-specific observer evidence, kept outside the Coding-Agent workdir.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hash, indexTranscript } from './brainstorming-evidence.ts';

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      if (entry.name === '.git' || entry.name === 'node_modules') return [];
      const path = join(root, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Capture cannot follow a symlink: ${path}`);
      if (entry.isDirectory()) return files(path);
      if (!entry.isFile())
        throw new Error(`Capture requires a regular file: ${path}`);
      return [path];
    });
}

function documents(workdir: string): Record<string, string> {
  return Object.fromEntries(
    files(workdir)
      .filter((path) => /\.md$/i.test(path))
      .map((path) => [path, readFileSync(path, 'utf8')]),
  );
}

function inventory(workdir: string): Record<string, string> {
  return Object.fromEntries(
    files(workdir).map((path) => [path, hash(readFileSync(path))]),
  );
}

function statePath(workdir: string): string {
  return join(dirname(workdir), 'gauntlet-agent', 'input-capture-state.json');
}

export function installInputCapture(workdir: string): void {
  workdir = resolve(workdir);
  mkdirSync(dirname(statePath(workdir)), { recursive: true });
  writeFileSync(
    statePath(workdir),
    JSON.stringify({ initial_files: inventory(workdir), raw_log: null }),
    { flag: 'wx', mode: 0o600 },
  );
  // JSON string literals quote both the import path and workdir inside JS;
  // no user-controlled shell text is evaluated by the installed executable.
  writeFileSync(
    join(dirname(statePath(workdir)), 'tui-input-guard'),
    `#!/usr/bin/env bun
import { captureInput } from ${JSON.stringify(import.meta.path)};
try {
  console.log(JSON.stringify(captureInput(${JSON.stringify(workdir)})));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 127;
}
`,
    { flag: 'wx', mode: 0o700 },
  );
}

export interface InputObservation {
  raw_log: string | null;
  raw: string;
  documents: Record<string, string>;
}

export function readInputObservation(workdir: string): InputObservation {
  const state = JSON.parse(readFileSync(statePath(workdir), 'utf8'));
  const root = join(dirname(workdir), 'home', '.codex', 'sessions');
  const target = realpathSync(workdir);
  const matches = files(root)
    .filter((path) => path.endsWith('.jsonl'))
    .filter((path) => {
      const first = readFileSync(path, 'utf8').split('\n')[0];
      const header = JSON.parse(first || '{}');
      // Review subagents share cwd; their source is an object with subagent
      // metadata. This pilot is pinned to Codex TUI, whose parent source is cli.
      return (
        header.type === 'session_meta' &&
        header.payload?.source === 'cli' &&
        typeof header.payload.cwd === 'string' &&
        existsSync(header.payload.cwd) &&
        realpathSync(header.payload.cwd) === target
      );
    });
  const docs = documents(workdir);
  if (
    matches.length === 0 &&
    !state.raw_log &&
    JSON.stringify(inventory(workdir)) === JSON.stringify(state.initial_files)
  ) {
    return { raw_log: null, raw: '', documents: docs };
  }
  if (matches.length !== 1 || (state.raw_log && matches[0] !== state.raw_log)) {
    throw new Error(
      'Capture requires exactly one unchanged main Codex rollout.',
    );
  }
  const rawLog = matches[0];
  if (!rawLog) throw new Error('Capture requires a main Codex rollout.');
  const raw = readFileSync(rawLog, 'utf8');
  if (!raw.endsWith('\n'))
    throw new Error(
      'Capture requires a complete JSONL boundary; retry after the current write.',
    );
  indexTranscript(raw);
  return { raw_log: rawLog, raw, documents: docs };
}

/** Publish only a stable pair of observations. Separate observations keep file
 * additions, deletions, rewrites and transcript append races visible. */
export function publishInputCapture(
  workdir: string,
  before: InputObservation,
  after: InputObservation,
) {
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error(
      'Capture changed during observation; retry after the current write.',
    );
  const receipts: {
    name: string;
    artifact_path: string;
    after_line: number;
  }[] = [];
  if (!after.raw_log) return { raw_log: null, receipts };
  const evidence = join(dirname(workdir), 'brainstorming-evidence');
  const id = randomUUID();
  const staging = join(dirname(statePath(workdir)), `capture-${id}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const afterLine = after.raw.split('\n').length - 1;
    for (const [artifactPath, content] of Object.entries(after.documents)) {
      const name = `capture-${id}-${receipts.length}`;
      const receipt = {
        schema_version: 1,
        artifact_path: artifactPath,
        content,
        content_sha256: hash(content),
        log_bytes: Buffer.byteLength(after.raw),
        log_sha256: hash(after.raw),
        after_line: afterLine,
      };
      writeFileSync(
        join(staging, `${name}.json`),
        `${JSON.stringify(receipt)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      receipts.push({
        name,
        artifact_path: artifactPath,
        after_line: afterLine,
      });
    }
    const state = JSON.parse(readFileSync(statePath(workdir), 'utf8'));
    writeFileSync(
      join(staging, 'state'),
      JSON.stringify({ ...state, raw_log: after.raw_log }),
      { mode: 0o600 },
    );
    renameSync(join(staging, 'state'), statePath(workdir));
    for (const receipt of receipts)
      renameSync(
        join(staging, `${receipt.name}.json`),
        join(evidence, `${receipt.name}.json`),
      );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { raw_log: after.raw_log, receipts };
}

export function captureInput(workdir: string) {
  workdir = resolve(workdir);
  return publishInputCapture(
    workdir,
    readInputObservation(workdir),
    readInputObservation(workdir),
  );
}
