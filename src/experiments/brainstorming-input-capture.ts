// Scenario-specific observer evidence, kept outside the Coding-Agent workdir.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readPinnedNoFollowBytes } from '../appliance/credential-scope.ts';
import {
  discoverObserverSources,
  indexBoundObserverSource,
  type ObserverBinding,
  readObserverNode,
  validateObserverBinding,
} from './observer/binding.ts';
import {
  captureFinalState,
  type FinalState,
  verifyFinalState,
} from './observer/final-state.ts';
import {
  type ArtifactReceipt,
  validateArtifactReceipt,
} from './observer/review.ts';

function statePath(workdir: string): string {
  return join(dirname(workdir), 'gauntlet-agent', 'input-capture-state.json');
}
export function observerBindingPath(workdir: string): string {
  return join(dirname(workdir), 'gauntlet-agent', 'observer-binding.json');
}
function readPrivateJson(path: string): unknown {
  const raw = readPinnedNoFollowBytes(
    dirname(path),
    [basename(path)],
    'observer state',
    true,
  );
  if (!raw) throw new Error('Observer state is unavailable.');
  return JSON.parse(raw.toString('utf8'));
}
function readBinding(workdir: string): ObserverBinding {
  const binding = validateObserverBinding(
    readPrivateJson(observerBindingPath(workdir)),
  );
  if (binding.workdir !== workdir)
    throw new Error('Observer workdir conflicts with installed binding.');
  return binding;
}
function artifactInventory(inventory: FinalState) {
  const roots = new Set(
    inventory.roots
      .filter((root) => root.kind === 'artifacts')
      .map((root) => root.id),
  );
  return inventory.nodes.filter((node) => roots.has(node.root_id));
}
function atomicJson(path: string, value: unknown): void {
  const staging = `${path}.${randomUUID()}`;
  try {
    writeFileSync(staging, `${JSON.stringify(value)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(staging, path);
  } finally {
    rmSync(staging, { force: true });
  }
}

export function installInputCapture(input: ObserverBinding): void {
  const binding = validateObserverBinding(input);
  if (binding.phase !== 'unbound')
    throw new Error('Capture installation requires an unbound runner binding.');
  const { workdir } = binding;
  const privateDir = dirname(statePath(workdir));
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const initial = captureFinalState(binding.roots);
  writeFileSync(observerBindingPath(workdir), `${JSON.stringify(binding)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(
    statePath(workdir),
    JSON.stringify({ initial_files: artifactInventory(initial) }),
    { flag: 'wx', mode: 0o600 },
  );
  mkdirSync(join(dirname(workdir), 'brainstorming-evidence'), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    join(privateDir, 'tui-input-guard'),
    `#!/usr/bin/env bun
import { guardedInputCapture } from ${JSON.stringify(import.meta.path)};
try {
  console.log(JSON.stringify(guardedInputCapture(${JSON.stringify(workdir)}, JSON.parse(await Bun.stdin.text()))));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 127;
}
`,
    { flag: 'wx', mode: 0o700 },
  );
  const context = join(privateDir, 'context');
  mkdirSync(context, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(context, 'BRAINSTORMING-OBSERVER.md'),
    `# Private observer instructions

Keep all observer files and evidence outside the Coding-Agent workspace and messages.
Runtime: ${binding.runtime}. Inspected dialect: ${binding.dialect}; build: ${binding.cli_version}.
This source subset does not establish native runtime qualification. Unknown records or parent provenance block evidence.
Follow the story's actor policy. Read presented artifacts before replying. The input guard captures actual Markdown bytes and complete source prefixes before terminal input.

The shared shell accepts only these exact observer commands. Substitute canonical base64 text for PATH_BASE64 or CONTENT_BASE64. Use no redirection, shell operators or command substitution.

- Index the bound source: ${observerCommand(workdir, 'observer-index')}
- Read an artifact or private receipt: ${observerCommand(workdir, 'observer-read', 'PATH_BASE64')}
- Save the complete V2 actor review once to private evidence/review.json: ${observerCommand(workdir, 'observer-write-review', 'CONTENT_BASE64')}

Receipts live in ${join(dirname(workdir), 'brainstorming-evidence')}. Each V2 receipt records observation_id, artifact_path, content_base64, bytes, sha256 and source_prefix. Select observations after presentation and before your reply. Equal document bytes at different observations have distinct IDs. A deleted file has no invented receipt.
A capture failure blocks input. Wait for a complete stable write, retry, or stop using Escape/Ctrl+C. Never bypass the guard or edit subject artifacts through another process. Classify every canonical call and retain explicit uncertainty; a spawn acknowledgment does not prove a child has finished. Child user messages cannot approve parent work. Do not invent parent authority or native qualification.
`,
    { flag: 'wx', mode: 0o600 },
  );
}

export interface InputObservation {
  binding: ObserverBinding;
  inventory: FinalState;
  raw_log: string | null;
  raw_base64: string;
  documents: Record<string, string>;
}
export function readInputObservation(workdir: string): InputObservation {
  const installed = readBinding(workdir);
  const binding = discoverObserverSources(installed);
  const inventory = captureFinalState(binding.roots);
  const state = readPrivateJson(statePath(workdir)) as {
    initial_files: unknown;
  };
  if (
    binding.phase === 'unbound' &&
    JSON.stringify(artifactInventory(inventory)) !==
      JSON.stringify(state.initial_files)
  )
    throw new Error(
      'Capture requires a parent source after startup inventory changes.',
    );
  const documents: Record<string, string> = {};
  for (const node of artifactInventory(inventory)) {
    if (node.kind === 'file' && /\.md$/i.test(node.path))
      documents[node.path] = readObserverNode(binding, node).toString('base64');
  }
  const parent = binding.sources.find(
    (entry) => entry.source.source_id === binding.parent_source_id,
  );
  let rawLog: string | null = null;
  let rawBase64 = '';
  if (parent) {
    const node = inventory.nodes.find(
      (node) =>
        node.root_id === parent.root_id && node.path === parent.relative_path,
    );
    const root = binding.roots.find((root) => root.id === parent.root_id);
    if (
      !node ||
      !root ||
      node.device !== parent.device ||
      node.inode !== parent.inode
    )
      throw new Error('Bound parent identity changed during capture.');
    const raw = readObserverNode(binding, node);
    indexBoundObserverSource(binding, parent.source, raw);
    rawLog = join(root.path, parent.relative_path);
    rawBase64 = raw.toString('base64');
  }
  verifyFinalState(binding.roots, inventory);
  return {
    binding,
    inventory,
    raw_log: rawLog,
    raw_base64: rawBase64,
    documents,
  };
}

/** Publish only byte-identical, stable observations; never repair a raced capture. */
export function publishInputCapture(
  workdir: string,
  before: InputObservation,
  after: InputObservation,
) {
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error(
      'Capture changed during observation; retry after the current write.',
    );
  verifyFinalState(after.binding.roots, after.inventory);
  const receipts: {
    name: string;
    artifact_path: string;
    observation_id: string;
  }[] = [];
  if (!after.raw_log) return { raw_log: null, receipts };
  const parent = after.binding.sources.find(
    (entry) => entry.source.source_id === after.binding.parent_source_id,
  );
  if (!parent) throw new Error('Capture requires its bound parent.');
  const prefix = indexBoundObserverSource(
    after.binding,
    parent.source,
    Buffer.from(after.raw_base64, 'base64'),
  ).prefix;
  for (const [artifactPath, contentBase64] of Object.entries(after.documents)) {
    const content = Buffer.from(contentBase64, 'base64');
    const id = randomUUID();
    const receipt: ArtifactReceipt = validateArtifactReceipt({
      schema_version: 2,
      observation_id: id,
      source_prefix: prefix,
      artifact_path: artifactPath,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      content_base64: contentBase64,
    });
    const name = `capture-${id}`;
    writeFileSync(
      join(dirname(workdir), 'brainstorming-evidence', `${name}.json`),
      `${JSON.stringify(receipt)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    receipts.push({ name, artifact_path: artifactPath, observation_id: id });
  }
  atomicJson(observerBindingPath(workdir), after.binding);
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

const observerCli = resolve(
  import.meta.dir,
  '../cli/brainstorming-evidence.ts',
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function observerCommand(
  workdir: string,
  operation: 'observer-index' | 'observer-read' | 'observer-write-review',
  argument?: string,
): string {
  return [
    process.execPath,
    observerCli,
    operation,
    Buffer.from(workdir).toString('base64'),
    ...(argument === undefined ? [] : [argument]),
  ]
    .map(quote)
    .join(' ');
}
function canonicalBase64(value: string): boolean {
  return Buffer.from(value, 'base64').toString('base64') === value;
}
export function guardedInputCapture(workdir: string, request: unknown) {
  if (!request || typeof request !== 'object')
    throw new Error('Input guard requires a tool request.');
  const { name, args } = request as {
    name: unknown;
    args: Record<string, unknown>;
  };
  if (!args || typeof args !== 'object')
    throw new Error('Input guard requires tool arguments.');
  if (
    name === 'press' &&
    (args['key'] === 'Escape' || args['key'] === 'Ctrl+C')
  )
    return { cancel: true };
  if (name === 'bash') {
    const command = args['command'];
    if (typeof command !== 'string')
      throw new Error('Shared shell requires one observer command.');
    const allowed =
      command === observerCommand(workdir, 'observer-index') ||
      (['observer-read', 'observer-write-review'] as const).some(
        (operation) => {
          const prefix = `${observerCommand(workdir, operation)} `;
          if (!command.startsWith(prefix)) return false;
          const rest = command.slice(prefix.length);
          return (
            /^'[A-Za-z0-9+/]*={0,2}'$/.test(rest) &&
            canonicalBase64(rest.slice(1, -1))
          );
        },
      );
    if (!allowed)
      throw new Error(
        'Shared shell accepts only a single private observer command; artifact edits and reply injection are refused.',
      );
  } else if (name !== 'type' && name !== 'press' && name !== 'type_and_submit')
    throw new Error('Input route is not supported.');
  return captureInput(workdir);
}

export function runObserverCommand(
  operation: string,
  encodedWorkdir: string,
  argument?: string,
): unknown {
  if (!canonicalBase64(encodedWorkdir))
    throw new Error('Observer workdir must be canonical base64.');
  const workdir = Buffer.from(encodedWorkdir, 'base64').toString('utf8');
  const binding = readBinding(workdir);
  const evidence = join(dirname(workdir), 'brainstorming-evidence');
  if (operation === 'observer-index' && argument === undefined) {
    const observation = readInputObservation(workdir);
    const parent = observation.binding.sources.find(
      (entry) =>
        entry.source.source_id === observation.binding.parent_source_id,
    );
    if (!parent) throw new Error('No bound parent is available to review.');
    return indexBoundObserverSource(
      observation.binding,
      parent.source,
      Buffer.from(observation.raw_base64, 'base64'),
    );
  }
  if (argument === undefined || !canonicalBase64(argument))
    throw new Error('Observer argument must be canonical base64.');
  const bytes = Buffer.from(argument, 'base64');
  if (operation === 'observer-write-review') {
    // Publication validates review semantics; this operation records actor bytes.
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    writeFileSync(join(evidence, 'review.json'), bytes, {
      flag: 'wx',
      mode: 0o600,
    });
    return { path: join(evidence, 'review.json') };
  }
  if (operation === 'observer-read') {
    const path = resolve(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    const root = [
      binding.workdir,
      evidence,
      join(dirname(statePath(workdir)), 'context'),
    ].find((root) => path.startsWith(`${root}/`));
    if (!root)
      throw new Error(
        'Observer read must remain within artifacts or private evidence/context.',
      );
    const raw = readPinnedNoFollowBytes(
      root,
      path.slice(root.length + 1).split('/'),
      'observer read',
      true,
    );
    return { path, content_base64: raw?.toString('base64') };
  }
  throw new Error('Observer command is not supported.');
}
