// Scenario-specific observer evidence, kept outside the Coding-Agent workdir.
import { createHash, randomUUID } from 'node:crypto';
import {
  fstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  closePin,
  pinAbsoluteDir,
  readPinnedNoFollowBytes,
} from '../appliance/credential-scope.ts';
import {
  discoverObserverSources,
  indexBoundObserverSource,
  type ObserverBinding,
  readObserverNode,
  readObserverSupportingFiles,
  validateObserverBinding,
} from './observer/binding.ts';
import {
  type ObserverSupportingFile,
  RawPrefixSchema,
} from './observer/contracts.ts';
import {
  captureFinalState,
  type FinalState,
  verifyFinalState,
} from './observer/final-state.ts';
import { verifyRawPrefix } from './observer/raw.ts';
import {
  type ArtifactReceipt,
  createSupportingPrefixes,
  validateActorReview,
  validateArtifactReceipt,
  verifySupportingPrefixes,
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

- List authenticated receipt IDs and paths (at most 16 entries and 32 KiB of serialized UTF-8 per page): ${observerCommand(workdir, 'observer-receipts')}
  If next_cursor is non-null, append it as one single-quoted base64 argument to that same command. Read the returned receipt path with observer-read and cite its observation_id.
- Index the bound source as bounded JSON byte chunks: ${observerCommand(workdir, 'observer-index')}
- Read an artifact or exact private receipt bytes: ${observerCommand(workdir, 'observer-read', 'PATH_BASE64')}
- Read the saved document revision inside an authenticated receipt: ${observerCommand(workdir, 'observer-read', 'PATH_BASE64', undefined, 'receipt-content')}
- Save the complete V2 actor review once to private evidence/review.json: ${observerCommand(workdir, 'observer-write-review', 'CONTENT_BASE64')}

Index and read return offset, bytes, sha256, content_utf8, content_base64 and next_cursor. Read content_utf8 directly in offset order until next_cursor is null. These character-aligned text chunks expose all index JSON, physical payloads, document text and receipt metadata without a shell decoder. content_base64 preserves the identical raw bytes for machine verification; concatenate separately decoded chunks and verify total bytes and sha256. Binary members have null content_utf8. Each serialized response is at most 32 KiB. One physical call/result can span chunks: do not classify partial payloads or omit later chunks.
For index continuation, append next_cursor as one single-quoted base64 argument to observer-index. For read continuation, append next_cursor after the unchanged single-quoted PATH_BASE64 argument and, when selected, the literal single-quoted receipt-content view. Use this view to inspect a saved approval revision directly as text; the live artifact may already differ. Cursors cannot switch path, view, receipt identity or content. Index cursors authenticate the original raw prefix even if new records arrive; a changed tool trace snapshot refuses continuation and requires a fresh index; after the subject stops, request a fresh index and review its complete final prefix. File cursors require unchanged authenticated bytes and path; on a refused continuation restart the read and never combine revisions. No other argument forms are supported.


Receipts live in ${join(dirname(workdir), 'brainstorming-evidence')}. Each V2 receipt records observation_id, artifact_path, content_base64, bytes, sha256 and source_prefix plus supporting_prefixes for tool trace members. Select observations after presentation and before your reply. Equal document bytes at different observations have distinct IDs. A deleted file has no invented receipt.
A capture failure blocks input. Wait for a complete stable write, retry, or stop using Escape/Ctrl+C. Never bypass the guard or edit subject artifacts through another process. Read BRAINSTORMING-ANNOTATIONS.md for the complete V2 actor-review schema. Copy source_prefixes and supporting_prefixes from the final complete indexes; use physical {source_id,line,block} anchors, observation_id receipts, and result_anchors for every canonical call result. Classify every canonical call and retain explicit uncertainty; a spawn acknowledgment does not prove a child has finished. Child user messages cannot approve parent work. Do not invent parent authority or native qualification.
`,
    { flag: 'wx', mode: 0o600 },
  );
}

export interface InputObservation {
  binding: ObserverBinding;
  inventory: FinalState;
  raw_log: string | null;
  raw_base64: string;
  supporting_files: ObserverSupportingFile[];
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
  const supporting_files = readObserverSupportingFiles(binding, inventory);
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
    indexBoundObserverSource(binding, parent.source, raw, supporting_files);
    rawLog = join(root.path, parent.relative_path);
    rawBase64 = raw.toString('base64');
  }
  verifyFinalState(binding.roots, inventory);
  return {
    binding,
    inventory,
    raw_log: rawLog,
    raw_base64: rawBase64,
    supporting_files,
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
    after.supporting_files,
  ).prefix;
  for (const [artifactPath, contentBase64] of Object.entries(after.documents)) {
    const content = Buffer.from(contentBase64, 'base64');
    const id = randomUUID();
    const receipt: ArtifactReceipt = validateArtifactReceipt({
      schema_version: 2,
      observation_id: id,
      source_prefix: prefix,
      supporting_prefixes: createSupportingPrefixes(after.supporting_files),
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
  operation:
    | 'observer-index'
    | 'observer-receipts'
    | 'observer-read'
    | 'observer-write-review',
  argument?: string,
  cursor?: string,
  view?: 'receipt-content',
): string {
  return [
    process.execPath,
    observerCli,
    operation,
    Buffer.from(workdir).toString('base64'),
    ...(argument === undefined ? [] : [argument]),
    ...(view === undefined ? [] : [view]),
    ...(cursor === undefined ? [] : [cursor]),
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
      command === observerCommand(workdir, 'observer-receipts') ||
      (
        [
          'observer-index',
          'observer-read',
          'observer-write-review',
          'observer-receipts',
        ] as const
      ).some((operation) => {
        const prefix = `${observerCommand(workdir, operation)} `;
        if (!command.startsWith(prefix)) return false;
        const rest = command.slice(prefix.length);
        const arguments_ = rest.split(' ');
        if (
          operation === 'observer-read' &&
          arguments_[1] === quote('receipt-content')
        )
          arguments_.splice(1, 1);
        return (
          (arguments_.length === 1 ||
            (operation === 'observer-read' && arguments_.length === 2)) &&
          arguments_.every(
            (value) =>
              /^'[A-Za-z0-9+/]*={0,2}'$/.test(value) &&
              canonicalBase64(value.slice(1, -1)),
          )
        );
      });
    if (!allowed)
      throw new Error(
        'Shared shell accepts only a single private observer command; artifact edits and reply injection are refused.',
      );
  } else if (name !== 'type' && name !== 'press' && name !== 'type_and_submit')
    throw new Error('Input route is not supported.');
  return captureInput(workdir);
}

const receiptFilename =
  /^capture-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/;
function readObservedReceipt(
  evidence: string,
  name: string,
  observation: InputObservation,
) {
  if (!receiptFilename.test(name))
    throw new Error('Receipt filename is not an owned capture identity.');
  const raw = readPinnedNoFollowBytes(
    evidence,
    [name],
    'observer receipt',
    true,
  );
  if (!raw) throw new Error('Observer receipt is unavailable.');
  const receipt = validateArtifactReceipt(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
  );
  if (name !== `capture-${receipt.observation_id}.json`)
    throw new Error(
      'Receipt filename conflicts with its observation identity.',
    );
  const parent = observation.binding.sources.find(
    (entry) => entry.source.source_id === observation.binding.parent_source_id,
  );
  if (!parent) throw new Error('Receipt requires its bound parent.');
  verifyRawPrefix(
    parent.source,
    Buffer.from(observation.raw_base64, 'base64'),
    receipt.source_prefix,
  );
  verifySupportingPrefixes(
    observation.supporting_files,
    receipt.supporting_prefixes,
    false,
  );
  return { raw, receipt };
}
function listObservedReceipts(
  workdir: string,
  evidence: string,
  cursor?: string,
) {
  const observation = readInputObservation(workdir);
  const pin = pinAbsoluteDir(evidence, 'observer receipts');
  try {
    const inventory = () =>
      readdirSync(pin.viaPath)
        .filter((name) => name.startsWith('capture-') && name.endsWith('.json'))
        .sort();
    const names = inventory();
    let after = -1;
    if (cursor !== undefined) {
      if (!canonicalBase64(cursor))
        throw new Error('Receipt cursor must be canonical base64.');
      const name = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(cursor, 'base64'),
      );
      after = names.indexOf(name);
      if (!receiptFilename.test(name) || after < 0)
        throw new Error('Receipt cursor must name an existing owned capture.');
    }
    const identities = new Set<string>();
    const metadata = names.map((name) => {
      const { raw, receipt } = readObservedReceipt(evidence, name, observation);
      if (identities.has(receipt.observation_id))
        throw new Error('Duplicate receipt observation identity.');
      identities.add(receipt.observation_id);
      return {
        path: join(evidence, name),
        observation_id: receipt.observation_id,
        artifact_path: receipt.artifact_path,
        source_prefix: receipt.source_prefix,
        supporting_prefixes: receipt.supporting_prefixes,
        bytes: receipt.bytes,
        sha256: receipt.sha256,
        file_bytes: raw.length,
        file_sha256: createHash('sha256').update(raw).digest('hex'),
      };
    });
    const current = pinAbsoluteDir(evidence, 'observer receipts');
    try {
      const before = fstatSync(pin.fd, { bigint: true });
      const after = fstatSync(current.fd, { bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        JSON.stringify(names) !== JSON.stringify(inventory())
      )
        throw new Error('Receipt inventory changed during observation.');
    } finally {
      closePin(current);
    }
    verifyFinalState(observation.binding.roots, observation.inventory);
    // The bash transport caps stdout at 64 KiB. Include the complete JSON
    // envelope, cursor and CLI newline; leave half the cap as transport headroom.
    const byteLimit = 32 * 1024;
    const pageFor = (start: number, end: number) => ({
      receipts: metadata.slice(start, end),
      next_cursor:
        end < names.length && names[end - 1]
          ? Buffer.from(names[end - 1] as string).toString('base64')
          : null,
    });
    const fits = (page: ReturnType<typeof pageFor>) =>
      Buffer.byteLength(`${JSON.stringify(page)}\n`, 'utf8') <= byteLimit;
    for (let index = 0; index < metadata.length; index++) {
      if (!fits(pageFor(index, index + 1)))
        throw new Error(
          'One receipt exceeds the receipt page byte limit; no records were truncated or skipped.',
        );
    }
    let end = after + 1;
    const limit = Math.min(after + 17, names.length);
    while (end < limit && fits(pageFor(after + 1, end + 1))) end++;
    return pageFor(after + 1, end);
  } finally {
    closePin(pin);
  }
}

const ObserverCursorSchema = z
  .object({
    operation: z.enum(['observer-index', 'observer-read']),
    authority_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().safe().positive(),
    prefix: RawPrefixSchema.nullable(),
  })
  .strict();
type ObserverCursor = z.infer<typeof ObserverCursorSchema>;
const digestBytes = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
function readObserverCursor(
  encoded: string | undefined,
): ObserverCursor | undefined {
  if (encoded === undefined) return undefined;
  if (!canonicalBase64(encoded))
    throw new Error('Observer cursor must be canonical base64.');
  return ObserverCursorSchema.parse(
    JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')),
  );
}

/** Transport chunks preserve every byte, even when one physical entry is large.
 * Continuations must reauthenticate the same content and source authority. */
function observerPage(
  raw: Buffer,
  identity: Omit<ObserverCursor, 'offset' | 'content_sha256'>,
  cursor?: ObserverCursor,
  member?: { path: string; view: 'raw' | 'receipt-content' },
) {
  const sha256 = digestBytes(raw);
  if (
    cursor &&
    (cursor.operation !== identity.operation ||
      cursor.authority_sha256 !== identity.authority_sha256 ||
      cursor.content_sha256 !== sha256 ||
      cursor.offset >= raw.length ||
      JSON.stringify(cursor.prefix) !== JSON.stringify(identity.prefix))
  )
    throw new Error(
      'Observer continuation differs from authenticated source content.',
    );
  const offset = cursor?.offset ?? 0;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let readable = true;
  try {
    decoder.decode(raw);
  } catch {
    readable = false;
  }
  const boundary = (end: number) => {
    if (readable)
      while (
        end > offset &&
        end < raw.length &&
        ((raw[end] ?? 0) & 0xc0) === 0x80
      )
        end--;
    return end;
  };
  const pageFor = (end: number) => ({
    ...member,
    bytes: raw.length,
    sha256,
    offset,
    content_base64: raw.subarray(offset, end).toString('base64'),
    content_utf8: readable ? decoder.decode(raw.subarray(offset, end)) : null,
    next_cursor:
      end < raw.length
        ? Buffer.from(
            JSON.stringify({
              ...identity,
              content_sha256: sha256,
              offset: end,
            }),
          ).toString('base64')
        : null,
  });
  let end = boundary(Math.min(raw.length, offset + 12 * 1024));
  let page = pageFor(end);
  while (Buffer.byteLength(`${JSON.stringify(page)}\n`, 'utf8') > 32 * 1024) {
    end = boundary(offset + Math.floor((end - offset) / 2));
    if (end <= offset)
      throw new Error(
        'Observer page envelope exceeds the transport byte limit; no evidence was truncated.',
      );
    page = pageFor(end);
  }
  return page;
}

export function runObserverCommand(
  operation: string,
  encodedWorkdir: string,
  argument?: string,
  continuation?: string,
  view?: 'receipt-content',
): unknown {
  if (!canonicalBase64(encodedWorkdir))
    throw new Error('Observer workdir must be canonical base64.');
  if (
    (continuation !== undefined || view !== undefined) &&
    operation !== 'observer-read'
  )
    throw new Error('Only observer-read accepts a path and continuation.');
  const workdir = Buffer.from(encodedWorkdir, 'base64').toString('utf8');
  const binding = readBinding(workdir);
  const evidence = join(dirname(workdir), 'brainstorming-evidence');
  if (operation === 'observer-receipts')
    return listObservedReceipts(workdir, evidence, argument);
  if (operation === 'observer-index') {
    const cursor = readObserverCursor(argument);
    const observation = readInputObservation(workdir);
    const parent = observation.binding.sources.find(
      (entry) =>
        entry.source.source_id === observation.binding.parent_source_id,
    );
    if (!parent) throw new Error('No bound parent is available to review.');
    const raw = Buffer.from(observation.raw_base64, 'base64');
    if (cursor) {
      if (cursor.operation !== 'observer-index' || cursor.prefix === null)
        throw new Error('Index continuation requires a bound source prefix.');
      verifyRawPrefix(parent.source, raw, cursor.prefix);
    }
    const index = indexBoundObserverSource(
      observation.binding,
      parent.source,
      cursor ? raw.subarray(0, cursor.prefix?.bytes) : raw,
      observation.supporting_files,
    );
    return observerPage(
      Buffer.from(
        JSON.stringify({
          ...index,
          supporting_prefixes: createSupportingPrefixes(
            observation.supporting_files,
          ),
        }),
      ),
      {
        operation: 'observer-index',
        authority_sha256: digestBytes(
          JSON.stringify([
            observation.binding,
            createSupportingPrefixes(observation.supporting_files),
          ]),
        ),
        prefix: index.prefix,
      },
      cursor,
    );
  }
  if (argument === undefined || !canonicalBase64(argument))
    throw new Error('Observer argument must be canonical base64.');
  const bytes = Buffer.from(argument, 'base64');
  if (operation === 'observer-write-review') {
    validateActorReview(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
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
    let receiptSha256: string | null = null;
    if (
      view !== undefined &&
      !(root === evidence && basename(path).startsWith('capture-'))
    )
      throw new Error(
        'Receipt-content view requires an authenticated capture receipt.',
      );
    const raw =
      root === evidence && basename(path).startsWith('capture-')
        ? (() => {
            if (dirname(path) !== evidence)
              throw new Error('Receipt must be an owned top-level capture.');
            const observation = readInputObservation(workdir);
            const { raw, receipt } = readObservedReceipt(
              evidence,
              basename(path),
              observation,
            );
            verifyFinalState(observation.binding.roots, observation.inventory);
            receiptSha256 = digestBytes(raw);
            return view === 'receipt-content'
              ? Buffer.from(receipt.content_base64, 'base64')
              : raw;
          })()
        : readPinnedNoFollowBytes(
            root,
            path.slice(root.length + 1).split('/'),
            'observer read',
            true,
          );
    if (!raw) throw new Error('Observer read is missing.');
    return observerPage(
      raw,
      {
        operation: 'observer-read',
        authority_sha256: digestBytes(
          JSON.stringify({
            binding,
            path,
            view: view ?? 'raw',
            receipt_sha256: receiptSha256,
          }),
        ),
        prefix: null,
      },
      readObserverCursor(continuation),
      { path, view: view ?? 'raw' },
    );
  }
  throw new Error('Observer command is not supported.');
}
