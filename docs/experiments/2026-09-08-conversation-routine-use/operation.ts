import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  fstatSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from 'node:path';
import { z } from 'zod';
import { loadStateConfig } from '../../../src/appliance/config.ts';
import { readPinnedNoFollowBytes } from '../../../src/appliance/credential-scope.ts';
import { ensurePrivateDirNoFollow } from '../../../src/appliance/safe-fs.ts';
import { createDurableMarker } from '../../../src/campaign/journal.ts';
import {
  acquireLease,
  realProcessIdentityProbe,
} from '../../../src/campaign/locks.ts';
import { currentProcessIdentity } from '../../../src/campaign/ownership.ts';
import { verifyPricingSnapshot } from '../../../src/campaign/pricing-snapshot.ts';
import { getEnv } from '../../../src/env.ts';
import { createRoleHeartbeatScheduler } from '../../../src/runner/retained-role.ts';
import { RealClock } from '../../../src/scheduler/clock.ts';
import type { ReleaseEnvelope } from './envelope.ts';

const absolute = z
  .string()
  .refine((p) => isAbsolute(p) && normalize(p) === p && !p.includes('\0'));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.object({ path: absolute, sha256: digest }).strict();
const ManifestSchema = z
  .object({
    qRoot: absolute,
    qSha: z.string().regex(/^[a-f0-9]{40}$/),
    gRoot: absolute,
    gSha: z.string().regex(/^[a-f0-9]{40}$/),
    config: reference,
    stateRoot: absolute,
    caseRoot: absolute,
    outputRoot: absolute,
    round: z.union([z.literal(1), z.literal(2)]),
    mode: z.enum(['assessment', 'driver', 'campaign']),
    operationId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    operationReceipt: absolute,
    privateLog: absolute,
    releaseEnvelope: z
      .object({ path: absolute, sha256: digest.optional() })
      .strict(),
    frozenInputs: z.array(reference).min(1),
    admissionRefs: z.array(reference).min(1),
  })
  .strict()
  .refine(
    (m) =>
      m.releaseEnvelope.sha256 !== undefined ||
      (m.round === 1 && m.mode === 'assessment'),
    'only the initial assessment may bootstrap the envelope',
  );
export type RoutineManifest = z.infer<typeof ManifestSchema>;
export function parseRoutineManifest(value: unknown): RoutineManifest {
  return ManifestSchema.parse(value);
}

export const marker = (path: string, value: unknown) =>
  createDurableMarker(path, `${JSON.stringify(value)}\n`);
export const hash = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
export function readPrivate(path: string): Buffer {
  const bytes = readPinnedNoFollowBytes(
    dirname(path),
    [basename(path)],
    'routine private input',
    true,
  );
  if (bytes === null) throw new Error('private input missing');
  return bytes;
}
export function authenticate(ref: { path: string; sha256: string }): void {
  if (hash(readPrivate(ref.path)) !== ref.sha256)
    throw new Error('frozen input changed');
}
type OperationHost = {
  executingRoot: string;
  assertDetached(m: RoutineManifest): void;
  pricingDirectory: string | undefined;
};
const operationHost = (): OperationHost => ({
  executingRoot: realpathSync(resolve(import.meta.dir, '../../..')),
  assertDetached,
  pricingDirectory: getEnv('OBOL_PRICING_DIR'),
});
/** Host-effect seam is internal only; manifests and CLI cannot override it. */
export function prepareOperation(
  manifestPath: string,
  lost: () => void,
  host = operationHost(),
) {
  const manifestBytes = readPrivate(manifestPath),
    manifestDigest = hash(manifestBytes);
  const m = parseRoutineManifest(JSON.parse(manifestBytes.toString('utf8')));
  const verify = () => {
    if (hash(readPrivate(manifestPath)) !== manifestDigest)
      throw new Error('manifest changed');
    if (host.executingRoot !== m.qRoot)
      throw new Error('executing source is not manifest Q root');
    for (const [root, sha] of [
      [m.qRoot, m.qSha],
      [m.gRoot, m.gSha],
    ]) {
      if (realpathSync(root!) !== root)
        throw new Error('source root is redirected');
      const head = spawnSync('git', ['-C', root!, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      });
      const dirty = spawnSync('git', ['-C', root!, 'status', '--porcelain'], {
        encoding: 'utf8',
      });
      if (
        head.status !== 0 ||
        head.stdout.trim() !== sha ||
        dirty.status !== 0 ||
        dirty.stdout.trim()
      )
        throw new Error('source identity changed or dirty');
    }
    for (const ref of [m.config, ...m.frozenInputs, ...m.admissionRefs])
      authenticate(ref);
  };
  verify();
  const loaded = loadStateConfig(m.config.path);
  if (
    loaded.config.evals.path !== m.qRoot ||
    loaded.config.gauntlet.path !== m.gRoot ||
    join(loaded.config.root, 'state') !== m.stateRoot
  )
    throw new Error('configured source/state identity mismatch');
  const pricing = verifyPricingSnapshot({
    evalsRoot: m.qRoot,
    snapshot: {
      path: 'docs/experiments/2026-09-06-pr2258-pricing/current.json',
      sha256:
        '6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b',
    },
  });
  if (host.pricingDirectory !== pricing.directory)
    throw new Error('frozen pricing must be set before Bun startup');
  host.assertDetached(m);
  if (
    m.operationReceipt !== join(m.outputRoot, 'operation.json') ||
    dirname(m.privateLog) !== m.outputRoot
  )
    throw new Error('operation receipt must be in its private output root');
  const releaseRoot = dirname(m.releaseEnvelope.path);
  for (const root of [releaseRoot, m.outputRoot])
    if (
      realpathSync(root) !== root ||
      !lstatSync(root).isDirectory() ||
      (lstatSync(root).mode & 0o077) !== 0
    )
      throw new Error('private real release/output roots required');
  const lease = acquireLease({
    lockPath: join(releaseRoot, 'operation.lock'),
    label: 'routine operation',
    clock: new RealClock(),
    identity: realProcessIdentityProbe,
    scheduler: createRoleHeartbeatScheduler(lost),
  });
  try {
    const historyRoot = join(releaseRoot, 'operations');
    ensurePrivateDirNoFollow(
      releaseRoot,
      historyRoot,
      'routine operation receipts',
    );
    const history = readdirSync(historyRoot).map((name) => {
      const ref = reference.parse(
        JSON.parse(readPrivate(join(historyRoot, name)).toString('utf8')),
      );
      authenticate(ref);
      return {
        manifest: parseRoutineManifest(
          JSON.parse(readPrivate(ref.path).toString('utf8')),
        ),
      };
    });
    if (history.length === 0 && m.releaseEnvelope.sha256 !== undefined)
      throw new Error(
        'initial qualification must create its original envelope',
      );
    if (
      m.releaseEnvelope.sha256 === undefined &&
      (existsSync(m.releaseEnvelope.path) || history.length)
    )
      throw new Error('original envelope bootstrap already consumed');
    if (m.releaseEnvelope.sha256 !== undefined)
      authenticate({
        path: m.releaseEnvelope.path,
        sha256: m.releaseEnvelope.sha256,
      });
    if (history.length) {
      const initial = history.filter(
        (entry) => entry.manifest.releaseEnvelope.sha256 === undefined,
      );
      if (initial.length !== 1)
        throw new Error('one original envelope creation required');
      const original = reference.parse(
        JSON.parse(
          readPrivate(
            join(initial[0]!.manifest.outputRoot, 'envelope-created.json'),
          ).toString('utf8'),
        ),
      );
      authenticate(original);
      for (const entry of [...history, { manifest: m }]) {
        const ref = entry.manifest.releaseEnvelope;
        if (
          ref.path !== original.path ||
          (ref.sha256 !== undefined && ref.sha256 !== original.sha256)
        )
          throw new Error(
            'all operations must retain the original envelope identity',
          );
      }
    }
    checkOperationHistory(
      m,
      history.map((previous) => {
        const settled = join(previous.manifest.outputRoot, 'settled.json');
        if (!existsSync(settled))
          throw new Error('unsettled operation prevents admission');
        const outcome = z
          .object({ complete: z.boolean(), fault: z.string().nullable() })
          .passthrough()
          .parse(JSON.parse(readPrivate(settled).toString('utf8')));
        return { manifest: previous.manifest, ...outcome };
      }),
    );
    marker(m.operationReceipt, {
      operationId: m.operationId,
      manifestDigest,
      argv: process.argv,
      process: currentProcessIdentity(),
    });
    marker(join(historyRoot, `${m.operationId}.json`), {
      path: manifestPath,
      sha256: manifestDigest,
    });
    let envelopeDigest = m.releaseEnvelope.sha256;
    const envelope = (): ReleaseEnvelope => {
      if (!envelopeDigest) throw new Error('original envelope not yet frozen');
      authenticate({ path: m.releaseEnvelope.path, sha256: envelopeDigest });
      const original = z
        .object({ firstPaidAtMs: z.number().finite().nonnegative() })
        .strict()
        .parse(
          JSON.parse(readPrivate(m.releaseEnvelope.path).toString('utf8')),
        );
      let qualificationKnownUsd = 0;
      const campaigns = new Map<string, number>();
      for (const entry of [...history, { manifest: m }]) {
        const root = entry.manifest.outputRoot;
        for (const name of readdirSync(root)) {
          if (!/^\d\d$/.test(name)) continue;
          const settlement = join(root, name, 'settled.json');
          if (!existsSync(settlement))
            throw new Error('unsettled ordinal prevents admission');
          const row = JSON.parse(readPrivate(settlement).toString('utf8')) as {
            knownUsd: number;
          };
          qualificationKnownUsd = Number(
            (
              qualificationKnownUsd +
              z.number().finite().nonnegative().parse(row.knownUsd)
            ).toPrecision(15),
          );
        }
        const observations = join(root, 'observations');
        if (existsSync(observations))
          for (const name of readdirSync(observations)) {
            const row = z
              .object({
                campaignId: z.string(),
                knownUsd: z.number().finite().nonnegative(),
              })
              .passthrough()
              .parse(
                JSON.parse(
                  readPrivate(join(observations, name)).toString('utf8'),
                ),
              );
            campaigns.set(
              row.campaignId,
              Math.max(campaigns.get(row.campaignId) ?? 0, row.knownUsd),
            );
          }
      }
      return { ...original, qualificationKnownUsd, campaigns };
    };
    return {
      m,
      loaded,
      pricing,
      verify,
      lease,
      envelope,
      bootstrap() {
        if (m.releaseEnvelope.sha256 === undefined) {
          marker(m.releaseEnvelope.path, { firstPaidAtMs: Date.now() });
          envelopeDigest = hash(readPrivate(m.releaseEnvelope.path));
          marker(join(m.outputRoot, 'envelope-created.json'), {
            path: m.releaseEnvelope.path,
            sha256: hash(readPrivate(m.releaseEnvelope.path)),
          });
        }
      },
    };
  } catch (error) {
    lease.release();
    throw error;
  }
}

type AllocationIdentity = Pick<
  RoutineManifest,
  'round' | 'mode' | 'qSha' | 'gSha'
>;
export function checkOperationHistory(
  m: AllocationIdentity,
  history: readonly {
    manifest: AllocationIdentity;
    complete: boolean;
    fault: string | null;
  }[],
): void {
  if (
    m.mode === 'campaign' &&
    !['assessment', 'driver'].every((role) =>
      history.some((previous) => previous.manifest.mode === role),
    )
  )
    throw new Error('both complete qualification sets are required');
  for (const previous of history) {
    if (!previous.complete || previous.fault !== null)
      throw new Error('prior terminal fault prevents later stages');
    if (previous.manifest.round === m.round) {
      if (
        previous.manifest.qSha !== m.qSha ||
        previous.manifest.gSha !== m.gSha
      )
        throw new Error('changed candidate requires the repair round');
      if (previous.manifest.mode === m.mode)
        throw new Error('whole role/campaign allocation already consumed');
    }
    if (previous.manifest.round > m.round)
      throw new Error('cannot return to an earlier round');
  }
  if (m.round === 2 && !history.some((h) => h.manifest.round === 1))
    throw new Error('repair requires the original round');
}

function assertDetached(m: RoutineManifest): void {
  if (
    process.platform !== 'linux' ||
    process.stdin.isTTY ||
    process.stdout.isTTY ||
    process.stderr.isTTY
  )
    throw new Error('operator requires detached Linux execution');
  const sid = spawnSync('ps', ['-o', 'sid=', '-p', String(process.pid)], {
    encoding: 'utf8',
  });
  if (sid.status !== 0 || Number(sid.stdout.trim()) !== process.pid)
    throw new Error('operator must own its detached session');
  const log = lstatSync(m.privateLog);
  if (
    !log.isFile() ||
    realpathSync(m.privateLog) !== m.privateLog ||
    (log.mode & 0o077) !== 0
  )
    throw new Error('private detached log required');
  for (const fd of [1, 2]) {
    const stream = fstatSync(fd);
    if (stream.dev !== log.dev || stream.ino !== log.ino)
      throw new Error('stdio must be bound to the private log');
  }
}
