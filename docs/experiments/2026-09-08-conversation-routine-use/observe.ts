import { spawn } from 'node:child_process';
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads';
import { z } from 'zod';
import { resolveCampaignDirectory } from '../../../src/appliance/campaign.ts';
import { loadStateConfig } from '../../../src/appliance/config.ts';
import {
  readPublishedArtifact,
  readPublishedArtifactBytes,
} from '../../../src/campaign/attempt-publish.ts';
import type { CampaignStatus } from '../../../src/campaign/cancellation.ts';
import { observeCampaignStatus } from '../../../src/campaign/cancellation.ts';
import { readCommittedPrefix } from '../../../src/campaign/execution-journal.ts';
import { readComparisonFromPrefix } from '../../../src/campaign/report-publication.ts';
import {
  jcsCanonicalize,
  sha256Hex,
} from '../../../src/contracts/campaign/digest.ts';
import type { ArtifactRef } from '../../../src/contracts/campaign/execution.ts';
import { GauntletRolesSchema } from '../../../src/contracts/conversation.ts';
import { getEnv } from '../../../src/env.ts';
import { verifyReturnedTurns } from '../../../src/runner/role-usage.ts';
import type { CampaignObservation } from './envelope.ts';
import { authenticate, readPrivate } from './operation.ts';

/** Caller authenticates the attempt manifest binding before passing its published references. */
export function verifySettledRoles(
  resultsRoot: string,
  refs: readonly ArtifactRef[],
): { returnedTurns: number; startedRoles: number } {
  const records = refs.filter((ref) =>
    ref.path.endsWith('/gauntlet-roles.json'),
  );
  if (records.length !== 1)
    throw new Error('missing or ambiguous role process record');
  const recordRef = records[0]!;
  const roles = GauntletRolesSchema.parse(
    JSON.parse(readPublishedArtifact(resultsRoot, recordRef)),
  );
  const run = recordRef.path.slice(0, -'gauntlet-roles.json'.length);
  let returnedTurns = 0,
    startedRoles = 0;
  for (const role of Object.values(roles)) {
    if (role.started_at === null) {
      if (
        role.finished_at !== null ||
        role.process_exit !== null ||
        refs.some((ref) => ref.path === `${run}${role.out_dir}/usage.jsonl`)
      )
        throw new Error('unstarted role has execution evidence');
      continue;
    }
    startedRoles++;
    if (
      role.model !== 'anthropic.claude-sonnet-5' ||
      role.finished_at === null ||
      role.process_exit === null
    )
      throw new Error('settled role identity incomplete');
    const read = (name: string) => {
      const matches = refs.filter(
        (ref) => ref.path === `${run}${role.out_dir}/${name}`,
      );
      if (matches.length !== 1)
        throw new Error('missing returned usage evidence');
      return new TextDecoder('utf-8', { fatal: true }).decode(
        readPublishedArtifactBytes(resultsRoot, matches[0]!),
      );
    };
    returnedTurns += verifyReturnedTurns({
      model: role.model,
      runJsonl: read('run.jsonl'),
      usageJsonl: read('usage.jsonl'),
    }).returnedTurns;
  }
  return { returnedTurns, startedRoles };
}
export type VerifiedReceipt = { attemptId: string; digest: string };
const ObservationSchema = z
  .object({
    campaignId: z.string().min(1),
    knownUsd: z.number().finite().nonnegative(),
    pendingAttempts: z.number().int().nonnegative(),
    settledFault: z.string().nullable(),
    ownership: z.enum(['safe', 'unsafe']),
    terminal: z.boolean(),
    verified: z
      .array(
        z
          .object({
            attemptId: z.string().min(1),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(72),
  })
  .strict();
export type ObservationReceipt = z.infer<typeof ObservationSchema>;
/** Heavy synchronous authentication lives only in this bounded child process. */
export async function observe(
  configPath: string,
  campaignId: string,
  previous: readonly VerifiedReceipt[] = [],
): Promise<ObservationReceipt> {
  const loaded = loadStateConfig(configPath);
  const campaignDir = resolveCampaignDirectory(loaded, campaignId);
  const resultsRoot = loaded.config.container.results_root;
  const [status, accounting] = await Promise.all([
    readStatusConcurrently(configPath, campaignId),
    Promise.resolve().then(() => {
      const prefix = readCommittedPrefix(campaignDir);
      const report = readComparisonFromPrefix({
        campaignDir,
        resultsRoot,
        prefix,
      });
      const state = prefix.projection;
      if (state.experiment.campaign_id !== campaignId)
        throw new Error('campaign identity mismatch');
      const verified: VerifiedReceipt[] = [];
      const prior = new Map(previous.map((row) => [row.attemptId, row.digest]));
      let settledFault: string | null = null;
      let pendingAttempts = 0;
      for (const [attemptId, attempt] of state.attempts) {
        if (!attempt.stopped) {
          pendingAttempts++;
          continue;
        }
        const refs = [
          ...new Map(
            [
              ...(attempt.observation?.artifacts ?? []),
              ...(attempt.accounting?.artifacts ?? []),
            ].map((ref) => [jcsCanonicalize(ref), ref]),
          ).values(),
        ];
        const digest = sha256Hex(jcsCanonicalize(refs));
        try {
          if (prior.has(attemptId) && prior.get(attemptId) !== digest)
            throw new Error('settled artifact identity changed');
          const evidence = report.report.attempts.find(
            (row) => row.execution_attempt_id === attemptId,
          )?.evidence;
          if (
            !evidence?.publication_valid ||
            evidence.missingness.some((missing) =>
              refs.some((ref) => ref.path === missing.field),
            )
          )
            throw new Error('settled publication unavailable');
          if (!prior.has(attemptId)) verifySettledRoles(resultsRoot, refs);
          // Ordinary trajectory/economics remains the subject pricing authority.
          if (!evidence.subject_cost_complete || !evidence.grader_cost_complete)
            throw new Error('settled usage missing or unpriceable');
          verified.push({ attemptId, digest });
        } catch {
          settledFault ??= `settled accounting fault: ${attemptId}`;
        }
      }
      if (previous.some((row) => !state.attempts.has(row.attemptId)))
        settledFault ??= 'settled identity disappeared';
      return {
        knownUsd: report.report.accounting.combined_cost_usd.known_subtotal,
        pendingAttempts,
        settledFault,
        verified,
        terminated: state.termination !== null,
      };
    }),
  ]);
  return {
    campaignId,
    knownUsd: accounting.knownUsd,
    pendingAttempts: accounting.pendingAttempts,
    settledFault: accounting.settledFault,
    verified: accounting.verified,
    ownership:
      status.state === 'unresolved' || status.next_action === 'cancel'
        ? 'unsafe'
        : 'safe',
    terminal:
      accounting.terminated &&
      ['completed', 'cancelled', 'interrupted'].includes(status.state) &&
      status.next_action !== 'cancel',
  };
}
function readStatusConcurrently(
  configPath: string,
  campaignId: string,
): Promise<CampaignStatus> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { configPath, campaignId },
    });
    worker.once('message', (value: CampaignStatus) => resolve(value));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error('status worker failed'));
    });
  });
}
if (!isMainThread) {
  const { configPath, campaignId } = workerData as {
    configPath: string;
    campaignId: string;
  };
  const loaded = loadStateConfig(configPath);
  const campaignDir = resolveCampaignDirectory(loaded, campaignId);
  parentPort!.postMessage(
    observeCampaignStatus({ loaded, campaignDir, jobId: 'routine-observe' }),
  );
} else if (import.meta.main) {
  const [config, campaignId, previous, previousDigest, ...extra] =
    process.argv.slice(2);
  if (!config || !campaignId || extra.length)
    throw new Error('usage: observe.ts <config> <exact-campaign-id>');
  if ((previous === undefined) !== (previousDigest === undefined))
    throw new Error('incomplete prior receipt reference');
  if (previous && previousDigest)
    authenticate({ path: previous, sha256: previousDigest });
  observe(
    config,
    campaignId,
    previous
      ? ObservationSchema.parse(
          JSON.parse(readPrivate(previous).toString('utf8')),
        ).verified
      : [],
  )
    .then((value) => process.stdout.write(`${JSON.stringify(value)}\n`))
    .catch(() => {
      process.stderr.write('campaign observation failed\n');
      process.exitCode = 1;
    });
}

/** Read-only observer subprocess; its abort never addresses the separate cancellation child. */
export async function observationChild(
  argv: string[],
  signal: AbortSignal,
): Promise<ObservationReceipt> {
  if (signal.aborted) throw new Error('observation aborted');
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      env: { PATH: getEnv('PATH') },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let text = '';
    const abort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk) => {
      text += String(chunk);
      if (Buffer.byteLength(text) > 1_000_000) abort();
    });
    child.once('error', (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted || code !== 0 || Buffer.byteLength(text) > 1_000_000) {
        reject(new Error('observation child failed or aborted'));
        return;
      }
      try {
        resolve(ObservationSchema.parse(JSON.parse(text)));
      } catch {
        reject(new Error('invalid observation receipt'));
      }
    });
    if (signal.aborted) abort();
  });
}
