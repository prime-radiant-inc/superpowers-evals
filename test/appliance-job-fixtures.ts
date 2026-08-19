// Typed CreateJobRequest factories for the appliance tests.
//
// The job write interface is a strict kind-discriminated union with no
// omission mode (F13): every new job carries its full credential
// selection/scope/source-SHA triple, and TypeScript rejects a run/run-all
// request that is missing any part of it. Tests whose subject is something
// else (locks, prune eligibility, summary rendering, cancellation) still have
// to produce legal writes, so they build them here instead of hand-copying
// the triple into every call site.
import type { CreateJobRequest } from '../src/appliance/jobs.ts';
import {
  type CredentialSelection,
  EMPTY_CREDENTIAL_SCOPE,
  type LiveCredentialScope,
} from '../src/credentials/scope.ts';

// The evals HEAD a live request was resolved against. Fixed, not derived, so
// records stay byte-stable across runs.
export const FIXTURE_SOURCE_EVALS_SHA = 'e'.repeat(40);

// The real `codex × codex_sub` delivery: subscription auth mounts the codex
// OAuth directory and passes no env. Mirrors credentialScopeForSelection over
// the committed corpus, so the fixture cannot drift into a shape production
// never produces.
export const FIXTURE_LIVE_SELECTION: CredentialSelection = {
  agent: 'codex',
  credential: 'codex_sub',
};

export const FIXTURE_LIVE_SCOPE: LiveCredentialScope = {
  schemaVersion: 1,
  kind: 'live',
  agent: 'codex',
  runtimeFamily: 'codex',
  credential: 'codex_sub',
  agentEnv: [],
  geminiAuthType: null,
  oauth: { kind: 'codex', mountName: 'codex' },
};

interface JobRequestOptions {
  readonly superpowersRef?: string;
  readonly argv?: readonly string[];
  readonly requester?: CreateJobRequest['requester'];
}

interface LiveJobRequestOptions extends JobRequestOptions {
  readonly selection?: CredentialSelection;
  readonly scope?: LiveCredentialScope;
  readonly sourceEvalsSha?: string;
}

interface ImportJobRequestOptions extends JobRequestOptions {
  readonly runId?: string;
}

const DEFAULT_REQUESTER: CreateJobRequest['requester'] = {
  agent: null,
  thread: null,
  task: null,
};

export function liveJobRequest(
  kind: 'run' | 'run-all',
  options: LiveJobRequestOptions = {},
): CreateJobRequest {
  return {
    kind,
    superpowersRef: options.superpowersRef ?? 'main',
    argv: options.argv ?? ['quorum', kind],
    requester: options.requester ?? DEFAULT_REQUESTER,
    credentialSelection: options.selection ?? FIXTURE_LIVE_SELECTION,
    credentialScope: options.scope ?? FIXTURE_LIVE_SCOPE,
    credentialScopeSourceEvalsSha:
      options.sourceEvalsSha ?? FIXTURE_SOURCE_EVALS_SHA,
  };
}

export function prepareJobRequest(
  options: JobRequestOptions = {},
): CreateJobRequest {
  return {
    kind: 'prepare',
    superpowersRef: options.superpowersRef ?? 'main',
    argv: options.argv ?? ['prepare'],
    requester: options.requester ?? DEFAULT_REQUESTER,
    credentialSelection: null,
    credentialScope: EMPTY_CREDENTIAL_SCOPE,
    credentialScopeSourceEvalsSha: null,
  };
}

export function importJobRequest(
  options: ImportJobRequestOptions = {},
): CreateJobRequest {
  const base = {
    kind: 'import',
    superpowersRef: options.superpowersRef ?? 'unknown',
    argv: options.argv ?? ['evals-appliance', 'import'],
    requester: options.requester ?? DEFAULT_REQUESTER,
    credentialSelection: null,
    credentialScope: null,
    credentialScopeSourceEvalsSha: null,
  } as const;
  return options.runId === undefined ? base : { ...base, runId: options.runId };
}
