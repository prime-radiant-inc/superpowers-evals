import { createHash } from 'node:crypto';
import { type BigIntStats, lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  closePin,
  pinAbsoluteDir,
  readPinnedNoFollowBytes,
} from '../../appliance/credential-scope.ts';

export interface FinalStateRoot {
  id: string;
  kind: 'transcripts' | 'artifacts';
  path: string;
}

export interface FinalStateNode {
  root_id: string;
  path: string;
  kind: 'directory' | 'file';
  device: string;
  inode: string;
  bytes: number | null;
  sha256: string | null;
}

export interface FinalState {
  schema_version: 2;
  roots: { id: string; kind: FinalStateRoot['kind'] }[];
  nodes: FinalStateNode[];
}

export class FinalStateError extends Error {
  readonly code:
    | 'invalid_state'
    | 'source_unavailable'
    | 'source_changed'
    | 'final_state_mismatch';

  constructor(code: FinalStateError['code']) {
    super(
      {
        invalid_state: 'Final state is invalid.',
        source_unavailable: 'Final-state source is unavailable.',
        source_changed: 'Final-state source changed during observation.',
        final_state_mismatch:
          'Final-state source does not match the candidate.',
      }[code],
    );
    this.name = 'FinalStateError';
    this.code = code;
  }
}

const NonemptyStringSchema = z.string().min(1);
const DecimalStringSchema = z.string().regex(/^\d+$/);
const RelativePathSchema = z.string().refine(isSafeRelativePath);
const NonemptyRelativePathSchema = RelativePathSchema.refine(
  (path) => path !== '',
);

const FinalStateRootSchema: z.ZodType<FinalStateRoot> = z
  .object({
    id: NonemptyStringSchema,
    kind: z.enum(['transcripts', 'artifacts']),
    path: z.string().refine(isAbsolute),
  })
  .strict();

const FinalStateRootDescriptionSchema = z
  .object({
    id: NonemptyStringSchema,
    kind: z.enum(['transcripts', 'artifacts']),
  })
  .strict();

const FinalStateNodeSchema: z.ZodType<FinalStateNode> = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        root_id: NonemptyStringSchema,
        path: RelativePathSchema,
        kind: z.literal('directory'),
        device: DecimalStringSchema,
        inode: DecimalStringSchema,
        bytes: z.null(),
        sha256: z.null(),
      })
      .strict(),
    z
      .object({
        root_id: NonemptyStringSchema,
        path: NonemptyRelativePathSchema,
        kind: z.literal('file'),
        device: DecimalStringSchema,
        inode: DecimalStringSchema,
        bytes: z.number().int().safe().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  ],
);

const FinalStateSchema: z.ZodType<FinalState> = z
  .object({
    schema_version: z.literal(2),
    roots: z.array(FinalStateRootDescriptionSchema),
    nodes: z.array(FinalStateNodeSchema),
  })
  .strict();

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareNodes(left: FinalStateNode, right: FinalStateNode): number {
  return (
    compareText(left.root_id, right.root_id) ||
    compareText(left.path, right.path)
  );
}

function isSafeRelativePath(path: string): boolean {
  if (path === '') return true;
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path)
  ) {
    return false;
  }
  return !path
    .split('/')
    .some(
      (component) =>
        component === '' || component === '.' || component === '..',
    );
}

function invalidState(): never {
  throw new FinalStateError('invalid_state');
}

function validateRoots(roots: readonly FinalStateRoot[]): FinalStateRoot[] {
  const parsed = z.array(FinalStateRootSchema).safeParse(roots);
  if (!parsed.success) invalidState();
  const seen = new Set<string>();
  let hasTranscripts = false;
  let hasArtifacts = false;
  for (const root of parsed.data) {
    if (seen.has(root.id)) invalidState();
    seen.add(root.id);
    hasTranscripts ||= root.kind === 'transcripts';
    hasArtifacts ||= root.kind === 'artifacts';
  }
  if (!hasTranscripts || !hasArtifacts) invalidState();
  return parsed.data.sort((left, right) => compareText(left.id, right.id));
}

function validateState(candidate: FinalState): FinalState {
  const parsed = FinalStateSchema.safeParse(candidate);
  if (!parsed.success) invalidState();

  const rootIds = new Set<string>();
  for (const root of parsed.data.roots) {
    if (rootIds.has(root.id)) invalidState();
    rootIds.add(root.id);
  }
  if (
    !parsed.data.roots.some(({ kind }) => kind === 'transcripts') ||
    !parsed.data.roots.some(({ kind }) => kind === 'artifacts')
  ) {
    invalidState();
  }

  const nodeKeys = new Set<string>();
  const rootDirectories = new Set<string>();
  for (const node of parsed.data.nodes) {
    if (!rootIds.has(node.root_id)) invalidState();
    const key = `${node.root_id}\0${node.path}`;
    if (nodeKeys.has(key)) invalidState();
    nodeKeys.add(key);
    if (node.path === '') rootDirectories.add(node.root_id);
  }
  if ([...rootIds].some((id) => !rootDirectories.has(id))) invalidState();

  return {
    schema_version: 2,
    roots: parsed.data.roots.sort((left, right) =>
      compareText(left.id, right.id),
    ),
    nodes: parsed.data.nodes.sort(compareNodes),
  };
}

function sourceUnavailable(): never {
  throw new FinalStateError('source_unavailable');
}

function sourceChanged(): never {
  throw new FinalStateError('source_changed');
}

function readStats(path: string, changed: boolean): BigIntStats {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    return changed ? sourceChanged() : sourceUnavailable();
  }
}

function readEntries(path: string, changed: boolean): string[] {
  try {
    return readdirSync(path).sort(compareText);
  } catch {
    return changed ? sourceChanged() : sourceUnavailable();
  }
}

function sameDirectory(
  before: BigIntStats,
  after: BigIntStats,
  beforeEntries: readonly string[],
  afterEntries: readonly string[],
): boolean {
  return (
    before.isDirectory() &&
    after.isDirectory() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    JSON.stringify(beforeEntries) === JSON.stringify(afterEntries)
  );
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.isFile() &&
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function directoryNode(
  rootId: string,
  path: string,
  stats: BigIntStats,
): FinalStateNode {
  return {
    root_id: rootId,
    path,
    kind: 'directory',
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    bytes: null,
    sha256: null,
  };
}

function readFileNode(
  root: FinalStateRoot,
  relativeParts: readonly string[],
  before: BigIntStats,
): FinalStateNode {
  const relativePath = relativeParts.join('/');
  const absolutePath = join(root.path, ...relativeParts);
  if (!before.isFile()) sourceUnavailable();

  let bytes: Buffer;
  try {
    const body = readPinnedNoFollowBytes(
      root.path,
      relativeParts,
      'observer source',
      true,
    );
    if (body === null) sourceChanged();
    bytes = body;
  } catch (error) {
    if (error instanceof FinalStateError) throw error;
    let afterFailure: BigIntStats;
    try {
      afterFailure = lstatSync(absolutePath, { bigint: true });
    } catch {
      sourceChanged();
    }
    if (!sameFile(before, afterFailure)) sourceChanged();
    sourceUnavailable();
  }

  const after = readStats(absolutePath, true);
  if (!sameFile(before, after) || after.size !== BigInt(bytes.length)) {
    sourceChanged();
  }
  return {
    root_id: root.id,
    path: relativePath,
    kind: 'file',
    device: after.dev.toString(10),
    inode: after.ino.toString(10),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function observeRoot(root: FinalStateRoot): FinalStateNode[] {
  try {
    closePin(pinAbsoluteDir(root.path, 'observer source'));
  } catch {
    sourceUnavailable();
  }

  const nodes: FinalStateNode[] = [];
  const visit = (
    relativeParts: readonly string[],
    observed?: BigIntStats,
  ): void => {
    const relativePath = relativeParts.join('/');
    const absolutePath = join(root.path, ...relativeParts);
    const before = observed ?? readStats(absolutePath, false);
    if (!before.isDirectory()) sourceUnavailable();
    const beforeEntries = readEntries(absolutePath, false);
    nodes.push(directoryNode(root.id, relativePath, before));

    for (const name of beforeEntries) {
      const childParts = [...relativeParts, name];
      const childPath = join(root.path, ...childParts);
      const child = readStats(childPath, true);
      if (!child.isDirectory() && !child.isFile()) sourceUnavailable();
      if (
        root.kind === 'artifacts' &&
        (name === '.git' || name === 'node_modules')
      ) {
        continue;
      }
      if (child.isDirectory()) {
        visit(childParts, child);
      } else if (root.kind === 'artifacts' || name.endsWith('.jsonl')) {
        nodes.push(readFileNode(root, childParts, child));
      }
    }

    const afterEntries = readEntries(absolutePath, true);
    const after = readStats(absolutePath, true);
    if (!sameDirectory(before, after, beforeEntries, afterEntries)) {
      sourceChanged();
    }
  };

  visit([]);
  return nodes;
}

function observeRoots(roots: readonly FinalStateRoot[]): FinalState {
  return validateState({
    schema_version: 2,
    roots: roots.map(({ id, kind }) => ({ id, kind })),
    nodes: roots.flatMap(observeRoot),
  });
}

function equalRoots(
  left: FinalState['roots'],
  right: FinalState['roots'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function equalState(left: FinalState, right: FinalState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function captureFinalState(
  roots: readonly FinalStateRoot[],
): FinalState {
  const validatedRoots = validateRoots(roots);
  const first = observeRoots(validatedRoots);
  const second = observeRoots(validatedRoots);
  if (!equalState(first, second)) sourceChanged();
  return second;
}

export function verifyFinalState(
  roots: readonly FinalStateRoot[],
  candidate: FinalState,
): void {
  const expected = validateState(candidate);
  const rootDescriptions = validateRoots(roots).map(({ id, kind }) => ({
    id,
    kind,
  }));
  if (!equalRoots(expected.roots, rootDescriptions)) invalidState();
  const actual = captureFinalState(roots);
  if (!equalState(expected, actual)) {
    throw new FinalStateError('final_state_mismatch');
  }
}
