// The immutable credential request an appliance run/run-all job is born with.
//
// It is constructed ONCE, in the program action, from the configured evals
// checkout and that checkout's current HEAD — before the action runs, before
// any job exists, and before anything touches state, the bundle, or Docker.
// Everything downstream (submitLiveJob, createJob, and in Task 5 the live
// execution binding) only carries it: nothing reparses argv or recomputes a
// scope after the fact, so the job record and the material the container
// receives cannot disagree about which single (agent, credential) cell this
// job is.
import {
  type CredentialSelection,
  credentialScopeForSelection,
  type LiveCredentialScope,
} from '../credentials/scope.ts';
import { ApplianceError } from './errors.ts';

export interface LiveCredentialRequest {
  readonly selection: CredentialSelection;
  readonly scope: LiveCredentialScope;
  readonly sourceEvalsSha: string;
}

/**
 * Resolve one normalized (agent, credential) selection against the corpus in
 * `evalsRoot` and pin it to `sourceEvalsSha`, the HEAD that corpus was read at.
 *
 * `selection.credential === null` means "the agent's default": the returned
 * selection preserves that request verbatim while the scope carries the
 * concrete credential it resolved to, so a later reader can tell a defaulted
 * cell from an explicitly named one.
 *
 * Pure with respect to appliance state: it reads the checkout and returns a
 * value. Every resolver failure — unknown agent or credential, missing
 * default, incompatible pair, unaudited delivery channel — becomes a typed
 * appliance error, because this runs inside the CLI's error envelope and an
 * untyped throw would surface as step 'unknown'.
 */
export function buildLiveCredentialRequest(
  evalsRoot: string,
  selection: CredentialSelection,
  sourceEvalsSha: string,
): LiveCredentialRequest {
  let scope: LiveCredentialScope;
  try {
    scope = credentialScopeForSelection(evalsRoot, selection);
  } catch (error) {
    if (error instanceof ApplianceError) {
      throw error;
    }
    throw new ApplianceError(
      'config_invalid',
      'credential-scope',
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    selection: { agent: selection.agent, credential: selection.credential },
    scope,
    sourceEvalsSha,
  };
}
