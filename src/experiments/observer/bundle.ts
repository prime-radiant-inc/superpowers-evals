import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  closePin,
  type PinnedDir,
  pinAbsoluteDir,
  pinChildDir,
  readPinnedNoFollowBytes,
} from '../../appliance/credential-scope.ts';
import { jcsCanonicalize } from '../../contracts/campaign/digest.ts';
import {
  ArtifactRefSchema,
  RelativeArtifactPathSchema,
} from '../../contracts/campaign/execution.ts';
import {
  indexBoundObserverSource,
  indexObserverSource,
  type ObserverBinding,
  ObserverBindingSchema,
  readObserverNode,
  validateObserverBinding,
} from './binding.ts';
import {
  captureFinalState,
  type FinalState,
  validateFinalState,
  verifyFinalState,
} from './final-state.ts';
import { verifyRawPrefix, verifyReviewedSuffix } from './raw.ts';
import { validateActorReview, validateArtifactReceipt } from './review.ts';
import {
  type StrictScore,
  StrictScoreSchema,
  scoreObserverEvidence,
} from './score.ts';
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

export const OBSERVER_BUNDLE_RELATIVE_DIR = 'brainstorming-evidence/bundle';
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

/** Capture once while the runner still owns the live sources. Interrupted stages are never repaired. */
export function freezeObserverBundle(
  input: ObserverBinding,
  evidenceDir: string,
): ObserverBundle {
  const binding = validateObserverBinding(input);
  if (binding.phase !== 'bound')
    throw new Error('Observer parent is unavailable or already finalized.');
  const evidence = pinAbsoluteDir(evidenceDir, 'observer evidence');
  try {
    if (readdirSync(evidence.viaPath).includes('bundle'))
      throw new Error('Observer candidate already exists.');
    const stage = join(evidence.viaPath, '.bundle-stage');
    mkdirSync(stage, { mode: 0o700 });
    const inventory = captureFinalState(binding.roots);
    const bundle: ObserverBundle = {
      schema_version: 2,
      binding: validateObserverBinding({ ...binding, phase: 'finalized' }),
      final_state: inventory,
      files: [],
      sources: [],
      terminal_artifacts: [],
      receipts: [],
      actor_review: null,
      score: null,
      evidence_errors: [],
    };
    const save = (path: string, bytes: Buffer): void => {
      writeFileSync(join(stage, path), bytes, { flag: 'wx', mode: 0o600 });
      bundle.files.push({
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    };
    for (const [index, node] of inventory.nodes.entries()) {
      if (node.kind !== 'file') continue;
      const bytes = readObserverNode(binding, node);
      const bound = binding.sources.find(
        (source) =>
          source.root_id === node.root_id && source.relative_path === node.path,
      );
      const path = `member-${index}`;
      save(path, bytes);
      if (bound)
        bundle.sources.push({ source_id: bound.source.source_id, path });
      else if (
        binding.roots.find((root) => root.id === node.root_id)?.kind ===
        'artifacts'
      )
        bundle.terminal_artifacts.push({
          root_id: node.root_id,
          relative_path: node.path,
          path,
        });
      else
        throw new Error(
          'Final transcript inventory contains an unbound source.',
        );
    }
    const receiptNames = readdirSync(evidence.viaPath)
      .filter((name) => name.startsWith('capture-') && name.endsWith('.json'))
      .sort();
    for (const [index, name] of receiptNames.entries()) {
      const bytes = readMember(evidenceDir, name);
      const receipt = validateArtifactReceipt(parseJson(bytes));
      if (name !== `capture-${receipt.observation_id}.json`)
        throw new Error('Receipt name conflicts with observation identity.');
      const path = `receipt-${index}.json`;
      save(path, bytes);
      bundle.receipts.push(path);
    }
    const reviewBytes = readPinnedNoFollowBytes(
      evidenceDir,
      ['review.json'],
      'observer review',
      false,
    );
    if (reviewBytes === null)
      bundle.evidence_errors.push({
        code: 'review_unavailable',
        message: 'Actor review was not recorded.',
      });
    else {
      save('review.json', reviewBytes);
      bundle.actor_review = 'review.json';
      try {
        const review = validateActorReview(
          parseJson(
            readMember(join(evidenceDir, '.bundle-stage'), 'review.json'),
          ),
        );
        const raw_sources = bundle.sources.map((ref) => ({
          source_id: ref.source_id,
          bytes: readMember(join(evidenceDir, '.bundle-stage'), ref.path),
        }));
        if (
          review.source_prefixes.length !== raw_sources.length ||
          new Set(review.source_prefixes.map((p) => p.source_id)).size !==
            raw_sources.length
        )
          throw new Error(
            'Review prefixes must cover the complete source inventory.',
          );
        for (const prefix of review.source_prefixes) {
          const source = binding.sources.find(
            (s) => s.source.source_id === prefix.source_id,
          );
          const raw = raw_sources.find((s) => s.source_id === prefix.source_id);
          if (!source || !raw) throw new Error('Review source is not bound.');
          verifyRawPrefix(source.source, raw.bytes, prefix);
          verifyReviewedSuffix(source.source, raw.bytes, prefix);
        }
        const score = scoreObserverEvidence({
          binding: bundle.binding,
          raw_sources,
          review,
          receipts: bundle.receipts.map((path) =>
            validateArtifactReceipt(
              parseJson(readMember(join(evidenceDir, '.bundle-stage'), path)),
            ),
          ),
        });
        save('score.json', Buffer.from(JSON.stringify(score)));
        bundle.score = 'score.json';
      } catch (error) {
        bundle.evidence_errors.push({
          code: 'invalid_review',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    writeFileSync(
      join(stage, OBSERVER_BUNDLE_FILENAME),
      JSON.stringify(bundle),
      { flag: 'wx', mode: 0o600 },
    );
    const validated = readObserverBundle(join(evidenceDir, '.bundle-stage'));
    verifyFinalState(binding.roots, inventory);
    const finalReceiptNames = readdirSync(evidence.viaPath)
      .filter((name) => name.startsWith('capture-') && name.endsWith('.json'))
      .sort();
    if (jcsCanonicalize(receiptNames) !== jcsCanonicalize(finalReceiptNames))
      throw new Error('Observer receipt inventory changed during freeze.');
    for (const [index, name] of receiptNames.entries()) {
      if (
        !readMember(evidenceDir, name).equals(
          readMember(
            join(evidenceDir, '.bundle-stage'),
            `receipt-${index}.json`,
          ),
        )
      )
        throw new Error('Observer receipt changed during freeze.');
    }
    const finalReview = readPinnedNoFollowBytes(
      evidenceDir,
      ['review.json'],
      'observer review',
      false,
    );
    if (
      reviewBytes === null
        ? finalReview !== null
        : finalReview === null || !reviewBytes.equals(finalReview)
    )
      throw new Error('Observer review changed during freeze.');
    // Persist all copied evidence before the single directory publication.
    for (const name of [
      ...bundle.files.map((file) => file.path),
      OBSERVER_BUNDLE_FILENAME,
    ]) {
      const fd = openSync(join(stage, name), 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    const stageFd = openSync(stage, 'r');
    try {
      fsyncSync(stageFd);
    } finally {
      closeSync(stageFd);
    }
    renameSync(stage, join(evidence.viaPath, 'bundle'));
    fsyncSync(evidence.fd);
    return validated;
  } finally {
    closePin(evidence);
  }
}

/** Read-only acceptance: never change, repair, or rescore a candidate after shutdown. */
export function verifyObserverCandidate(
  input: ObserverBinding,
  evidenceDir: string,
): void {
  const binding = validateObserverBinding(input);
  const bundle = readObserverBundle(join(evidenceDir, 'bundle'));
  if (
    binding.phase === 'unbound' ||
    jcsCanonicalize({ ...binding, phase: 'finalized' }) !==
      jcsCanonicalize(bundle.binding)
  )
    throw new Error('Observer candidate differs from runner binding.');
  verifyFinalState(binding.roots, bundle.final_state);
}

/** Consume the recorded strict score only; live paths and reduction are never consulted. */
export function readObserverScore(bundleDir: string): StrictScore {
  const bundle = readObserverBundle(bundleDir);
  if (bundle.score === null)
    throw new Error('Observer strict score is unavailable.');
  return StrictScoreSchema.parse(
    parseJson(authenticatedMember(bundleDir, bundle, bundle.score)),
  );
}

function authenticatedMember(
  bundleDir: string,
  bundle: ObserverBundle,
  path: string,
): Buffer {
  const file = bundle.files.find((file) => file.path === path);
  const bytes = readMember(bundleDir, path);
  if (
    !file ||
    bytes.length !== file.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== file.sha256
  )
    throw new Error('Observer member changed during consumption.');
  return bytes;
}

/** Index portable frozen sources. The original runtime paths remain provenance only. */
export function indexObserverBundle(bundleDir: string) {
  const bundle = readObserverBundle(bundleDir);
  return {
    schema_version: 2,
    sources: bundle.sources.map((ref) => {
      const bound = bundle.binding.sources.find(
        (source) => source.source.source_id === ref.source_id,
      );
      if (!bound) throw new Error('Bundle source is not bound.');
      const bytes = authenticatedMember(bundleDir, bundle, ref.path);
      return bound.parent_link === null
        ? indexBoundObserverSource(bundle.binding, bound.source, bytes)
        : indexObserverSource(bound.source, bytes);
    }),
  };
}
