import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishExecution } from '../../../src/campaign/attempt-publish.ts';
import {
  jcsCanonicalize,
  sha256Hex,
} from '../../../src/contracts/campaign/digest.ts';
import { writeAttemptManifest } from '../../../src/runner/manifest.ts';
import {
  blockActivation,
  fixtureTime,
  observation,
  sessionTransitions,
  startTransition,
  transition,
  twoArmExperiment,
} from './factory.ts';
import { lifecycleFixture } from './lifecycle.ts';
export function completedPublicationFixture(
  validityBlockId = 'primary',
  experiment = twoArmExperiment(),
  criteria?: Array<{ criterion: string; verdict: string; evidence: string }>,
  retainRun?: (
    runDir: string,
    identity: import('../../../src/contracts/campaign/campaign.ts').CampaignIdentity,
  ) => void,
) {
  const f = lifecycleFixture(experiment);

  const resultsRoot = join(f.root, 'custom-results');
  mkdirSync(resultsRoot);
  const block = blockActivation(f.experiment);
  for (const intent of block.attempts) {
    const original = intent.output_root;
    const root = join(f.root, 'attempts', intent.identity.execution_attempt_id);
    Object.assign(
      intent,
      JSON.parse(JSON.stringify(intent).replaceAll(original, root)),
    );
    intent.runtime_spec_digest = sha256Hex(
      jcsCanonicalize(intent.runtime_spec),
    );
  }
  const w = f.elect();
  for (const t of sessionTransitions(f.experiment).slice(1))
    w.commitTransition(t);
  w.commitTransition(transition('block_activated', block, 3));
  const observations = block.attempts.map((intent, i) => {
    const runDir = join(intent.output_root, 'staging', `run-${i}`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'verdict.json'),
      JSON.stringify({
        schema: 1,
        campaign: intent.identity,
        final: i === 0 ? 'pass' : 'fail',
        gauntlet: {
          status: i === 0 ? 'pass' : 'fail',
          summary: 'frozen',
          ...(criteria ? { criteria } : {}),
          reasoning: 'observed',
          run_id: 'grader',
          process_exit: { code: 0, signal: null },
        },
        checks: [
          {
            check: 'fixture',
            args: [],
            negated: false,
            passed: i === 0,
            detail: null,
            phase: 'post',
          },
        ],
        started_at: fixtureTime(0),
        finished_at: fixtureTime(10 + i),
        economics: {
          coding_agent: {
            est_cost_usd: i + 1,
            has_unpriced_model: false,
            tokens: { total: 10 + i },
          },
          gauntlet: {
            est_cost_usd: 0.1,
            has_unpriced_model: false,
            tokens: { total: 2 },
          },
        },
      }),
    );
    writeFileSync(join(runDir, 'Z-binary'), Buffer.from([255, 128, 0]));
    retainRun?.(runDir, intent.identity);
    const retainedVerdict = JSON.parse(
      readFileSync(join(runDir, 'verdict.json'), 'utf8'),
    );
    writeAttemptManifest(runDir, intent.identity);
    const container_id = (i === 0 ? 'a' : 'b').repeat(64);
    const stopped = {
      execution_attempt_id: intent.identity.execution_attempt_id,
      container_id,
      proof: 'inspected_stopped' as const,
      observed_at: fixtureTime(4 + i),
    };
    const result = publishExecution({
      bound: { intent, container_id },
      stopped,
      resultsRoot,
    });
    const obs = observation(block, i, 4 + i, {
      outcome: retainedVerdict.final,
      artifacts: result.artifacts,
      stopped,
    });
    w.commitTransition(
      transition(
        'attempt_observed',
        { observation: obs, excluded_block: null },
        4 + i,
      ),
    );
    return obs;
  });
  const receipt = {
    campaign_id: f.experiment.campaign_id,
    input_digest: f.experiment.input_digest,
    start_id: 'start',
    block_id: validityBlockId,
    at: fixtureTime(6),
    verdict: 'valid',
    details: {
      exposures: [1, 2],
      contention: 'clean',
      intervals: [{ block_id: 'primary', startTsMs: 0, endTsMs: 5000 }],
      telemetry: {
        lines: [
          {
            ts_ms: 5000,
            load1: 0,
            mem_available_bytes: 4096,
            swap_used_bytes: 0,
            process_count: 3,
            disk_free_bytes: 8192,
            breach: [],
          },
        ],
        truncatedTail: false,
      },
    },
  };
  const body = `${jcsCanonicalize(receipt)}\n`;
  writeFileSync(join(f.campaignDir, 'validity.json'), body);
  w.commitTransition(
    transition(
      'block_validated',
      {
        block_id: 'primary',
        evidence_refs: [
          {
            path: 'validity.json',
            sha256: sha256Hex(body),
            bytes: Buffer.byteLength(body),
          },
        ],
      },
      6,
    ),
  );
  w.release();
  writeFileSync(
    `${f.loaded.config.live_spend_lock}.claim.json`,
    jcsCanonicalize({
      ...startTransition(f.experiment).payload,
      campaign_dir: f.campaignDir,
    }),
  );
  return { ...f, resultsRoot, observations };
}
export function finishPublicationFixture(
  f: ReturnType<typeof completedPublicationFixture>,
) {
  const w = f.elect();
  w.commitTransition(
    transition(
      'ended',
      { outcome: 'completed', reason: 'done', cancel_intent: null },
      7,
    ),
  );
  const body = `${jcsCanonicalize({ start: startTransition(f.experiment).payload, controller: { pid: 102, birth: 'controller', boot_id: 'boot' }, launcher_role_released: true, authorized_terminator: { pid: 102, birth: 'controller', boot_id: 'boot' }, observed_at: fixtureTime(8) })}\n`;
  writeFileSync(join(f.campaignDir, 'termination.json'), body);
  w.commitTransition(
    transition(
      'termination_verified',
      {
        start_id: 'start',
        stopped: f.observations.map((o) => o.stopped),
        process_evidence: [
          {
            path: 'termination.json',
            bytes: Buffer.byteLength(body),
            sha256: sha256Hex(body),
          },
        ],
      },
      8,
    ),
  );
  w.release();
}
