import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CampaignIdentity } from '../contracts/campaign/campaign.ts';
import type { CredentialLabels } from '../contracts/credential.ts';
import { type FinalVerdict, FinalVerdictSchema } from '../contracts/verdict.ts';
import { readConversationRecord } from './conversation.ts';

export interface StoppedIdentity {
  readonly scenario: string;
  readonly codingAgent: string;
  readonly startedAt: string;
  readonly credential?: string;
  readonly campaign?: CampaignIdentity;
  readonly labels?: CredentialLabels;
}

// The verdict written when a run is interrupted by SIGINT (dashboard Stop).
// indeterminate + error.stage "stopped" (a valid RUN_ERROR_STAGES member). The
// cell resolves to indeterminate instead of vanishing under the dead-pid rule.
export function buildStoppedVerdict(id: StoppedIdentity): FinalVerdict {
  return {
    schema: 1,
    final: 'indeterminate',
    final_reason: 'run stopped before completion',
    gauntlet: null,
    checks: [],
    error: { stage: 'stopped', message: 'run interrupted by SIGINT' },
    economics: null,
    scenario: id.scenario,
    coding_agent: id.codingAgent,
    started_at: id.startedAt,
    finished_at: new Date().toISOString(),
    credential: id.credential,
    ...(id.labels !== undefined ? { labels: id.labels } : {}),
    ...(id.campaign !== undefined ? { campaign: id.campaign } : {}),
  };
}

export function writeStoppedVerdict(runDir: string, id: StoppedIdentity): void {
  let existing: FinalVerdict | null = null;
  try {
    existing = FinalVerdictSchema.parse(
      JSON.parse(readFileSync(join(runDir, 'verdict.json'), 'utf8')),
    );
  } catch {
    /* No valid verdict was written yet. */
  }
  const conversation = readConversationRecord(runDir) ?? existing?.conversation;
  const stopped = {
    ...existing,
    ...buildStoppedVerdict(id),
    checks: existing?.checks ?? [],
    gauntlet: existing?.gauntlet ?? null,
    economics: existing?.economics ?? null,
    ...(conversation ? { conversation } : {}),
  };
  writeFileSync(
    join(runDir, 'verdict.json'),
    `${JSON.stringify(stopped, null, 2)}\n`,
  );
}
