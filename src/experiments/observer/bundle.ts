import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  closePin,
  type PinnedDir,
  pinAbsoluteDir,
  pinChildDir,
  readPinnedNoFollowBytes,
} from '../../appliance/credential-scope.ts';
import {
  ArtifactRefSchema,
  RelativeArtifactPathSchema,
} from '../../contracts/campaign/execution.ts';
import { type ObserverBinding, ObserverBindingSchema } from './binding.ts';
import { type FinalState, validateFinalState } from './final-state.ts';
import { verifyRawPrefix } from './raw.ts';
import { validateArtifactReceipt } from './review.ts';
export interface ObserverBundle {
  schema_version: 2;
  binding: ObserverBinding;
  final_state: FinalState;
  files: { path: string; bytes: number; sha256: string }[];
  sources: { source_id: string; path: string }[];
  terminal_artifacts: {
    root_id: string;
    relative_path: string;
    path: string;
  }[];
  receipts: string[];
  actor_review: string | null;
  score: string | null;
  evidence_errors: { code: string; message: string }[];
}

export const OBSERVER_BUNDLE_FILENAME = 'observer-bundle.json';

const FinalStateSchema = z.unknown().transform((value, context): FinalState => {
  try {
    return validateFinalState(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid final state.' });
    return z.NEVER;
  }
});
const SourceRefSchema = z
  .object({ source_id: z.string().min(1), path: RelativeArtifactPathSchema })
  .strict();
const TerminalArtifactRefSchema = z
  .object({
    root_id: z.string().min(1),
    relative_path: RelativeArtifactPathSchema,
    path: RelativeArtifactPathSchema,
  })
  .strict();
export const ObserverBundleSchema: z.ZodType<
  ObserverBundle,
  z.ZodTypeDef,
  unknown
> = z
  .object({
    schema_version: z.literal(2),
    binding: ObserverBindingSchema,
    final_state: FinalStateSchema,
    files: z.array(ArtifactRefSchema).min(1),
    sources: z.array(SourceRefSchema).min(1),
    terminal_artifacts: z.array(TerminalArtifactRefSchema),
    receipts: z.array(RelativeArtifactPathSchema),
    actor_review: RelativeArtifactPathSchema.nullable(),
    score: RelativeArtifactPathSchema.nullable(),
    evidence_errors: z.array(
      z
        .object({ code: z.string().min(1), message: z.string().min(1) })
        .strict(),
    ),
  })
  .strict()
  .superRefine((bundle, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: 'custom', message });
    if (bundle.binding.phase !== 'finalized')
      issue('A bundle requires a finalized binding.');
    const files = new Map(bundle.files.map((file) => [file.path, file]));
    if (
      files.size !== bundle.files.length ||
      files.has(OBSERVER_BUNDLE_FILENAME)
    )
      issue('Bundle members must be unique and cannot include the envelope.');
    const references = [
      ...bundle.sources.map((source) => source.path),
      ...bundle.terminal_artifacts.map((artifact) => artifact.path),
      ...bundle.receipts,
      ...[bundle.actor_review, bundle.score].filter(
        (path): path is string => path !== null,
      ),
    ];
    if (
      new Set(references).size !== references.length ||
      references.length !== files.size ||
      references.some((path) => !files.has(path))
    )
      issue('Every bundle member requires exactly one explicit reference.');
    if (bundle.evidence_errors.length > 0 && bundle.score !== null)
      issue('Evidence errors cannot carry a behavioral score.');
    if (
      bundle.evidence_errors.length === 0 &&
      (bundle.actor_review === null || bundle.score === null)
    )
      issue('Unavailable review or score requires explicit evidence errors.');
    const roots = new Map(
      bundle.binding.roots.map((root) => [root.id, root.kind]),
    );
    if (
      bundle.final_state.roots.length !== roots.size ||
      bundle.final_state.roots.some((root) => roots.get(root.id) !== root.kind)
    )
      issue('Final state must retain the bound roots.');
    const key = (rootId: string, path: string) =>
      JSON.stringify([rootId, path]);
    const directories = new Set(
      bundle.final_state.nodes
        .filter((node) => node.kind === 'directory')
        .map((node) => key(node.root_id, node.path)),
    );
    for (const node of bundle.final_state.nodes) {
      if (node.path === '') continue;
      const parent = node.path.split('/').slice(0, -1).join('/');
      if (!directories.has(key(node.root_id, parent)))
        issue('Final inventory must retain every directory ancestor.');
    }
    const nodes = new Map(
      bundle.final_state.nodes
        .filter((node) => node.kind === 'file')
        .map((node) => [key(node.root_id, node.path), node]),
    );
    const sources = new Map(
      bundle.sources.map((source) => [source.source_id, source]),
    );
    if (
      sources.size !== bundle.sources.length ||
      sources.size !== bundle.binding.sources.length
    )
      issue('Source references must exactly cover the binding.');
    const covered = new Set<string>();
    for (const bound of bundle.binding.sources) {
      const nodeKey = key(bound.root_id, bound.relative_path);
      const node = nodes.get(nodeKey);
      const ref = sources.get(bound.source.source_id);
      const file = ref ? files.get(ref.path) : undefined;
      if (
        !node ||
        !file ||
        node.device !== bound.device ||
        node.inode !== bound.inode ||
        node.bytes !== file.bytes ||
        node.sha256 !== file.sha256
      )
        issue(
          'Bound source identity and bytes must match the final state and member.',
        );
      covered.add(nodeKey);
    }
    for (const artifact of bundle.terminal_artifacts) {
      const nodeKey = key(artifact.root_id, artifact.relative_path);
      const node = nodes.get(nodeKey);
      const file = files.get(artifact.path);
      if (
        covered.has(nodeKey) ||
        roots.get(artifact.root_id) !== 'artifacts' ||
        !node ||
        !file ||
        node.bytes !== file.bytes ||
        node.sha256 !== file.sha256
      )
        issue(
          'Terminal artifact references must exactly match the final state.',
        );
      covered.add(nodeKey);
    }
    if (
      covered.size !== nodes.size ||
      [...nodes.keys()].some((node) => !covered.has(node))
    )
      issue('The complete final file inventory must be retained.');
  });

function readMember(bundleDir: string, path: string): Buffer {
  const bytes = readPinnedNoFollowBytes(
    bundleDir,
    path.split('/'),
    'observer bundle',
    true,
  );
  if (bytes === null)
    throw new Error('Required observer bundle member is missing.');
  return bytes;
}

function parseJson(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function memberInventory(bundleDir: string): string[] {
  const root = pinAbsoluteDir(bundleDir, 'observer bundle');
  const files: string[] = [];
  const visit = (directory: PinnedDir, prefix: string): void => {
    for (const name of readdirSync(directory.viaPath)) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      RelativeArtifactPathSchema.parse(path);
      const stats = lstatSync(join(directory.viaPath, name));
      if (stats.isFile()) files.push(path);
      else if (stats.isDirectory()) {
        const child = pinChildDir(directory, name, 'observer bundle');
        if (!child) throw new Error('Observer bundle directory is missing.');
        try {
          visit(child, path);
        } finally {
          closePin(child);
        }
      } else
        throw new Error(
          'Observer bundle cannot contain symlinks or special files.',
        );
    }
  };
  try {
    visit(root, '');
    return files.sort();
  } finally {
    closePin(root);
  }
}

/** Authenticate frozen bytes only. Absolute binding paths are provenance, never replay inputs. */
export function readObserverBundle(bundleDir: string): ObserverBundle {
  const envelope = readMember(bundleDir, OBSERVER_BUNDLE_FILENAME);
  const bundle = ObserverBundleSchema.parse(parseJson(envelope));
  const expected = [
    OBSERVER_BUNDLE_FILENAME,
    ...bundle.files.map((file) => file.path),
  ].sort();
  if (JSON.stringify(memberInventory(bundleDir)) !== JSON.stringify(expected))
    throw new Error(
      'Observer bundle inventory is incomplete or contains undeclared members.',
    );
  const contents = new Map<string, Buffer>();
  for (const file of bundle.files) {
    const bytes = readMember(bundleDir, file.path);
    if (
      bytes.length !== file.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      throw new Error(
        'Observer bundle member bytes do not match the envelope.',
      );
    contents.set(file.path, bytes);
  }
  const contentAt = (path: string): Buffer => {
    const bytes = contents.get(path);
    if (!bytes)
      throw new Error('Referenced observer bundle member is missing.');
    return bytes;
  };
  const observations = new Set<string>();
  for (const path of bundle.receipts) {
    const receipt = validateArtifactReceipt(parseJson(contentAt(path)));
    if (observations.has(receipt.observation_id))
      throw new Error('Receipt observation identities must be unique.');
    observations.add(receipt.observation_id);
    const source = bundle.binding.sources.find(
      (bound) => bound.source.source_id === receipt.source_prefix.source_id,
    );
    const ref = bundle.sources.find(
      (entry) => entry.source_id === receipt.source_prefix.source_id,
    );
    if (!source || !ref)
      throw new Error('Receipt source is outside the binding.');
    verifyRawPrefix(source.source, contentAt(ref.path), receipt.source_prefix);
  }
  if (
    !readMember(bundleDir, OBSERVER_BUNDLE_FILENAME).equals(envelope) ||
    JSON.stringify(memberInventory(bundleDir)) !== JSON.stringify(expected)
  )
    throw new Error('Observer bundle changed during authentication.');
  return bundle;
}
