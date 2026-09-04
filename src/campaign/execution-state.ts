import { jcsCanonicalize, sha256Hex } from '../contracts/campaign/digest.ts';
import {
  type AccountingObservation,
  type AttemptIntent,
  type AttemptObservation,
  type BlockActivation,
  type CampaignTransition,
  CampaignTransitionSchema,
  type ExecutionStart,
  type ProcessIdentity,
  type ReplacementCause,
  type VerifiedStopped,
} from '../contracts/campaign/execution.ts';
import {
  type Experiment,
  ExperimentSchema,
} from '../contracts/campaign/experiment.ts';

type Payload<T extends CampaignTransition['type']> = Extract<
  CampaignTransition,
  { type: T }
>['payload'];
export interface AttemptProjection {
  intent: AttemptIntent;
  prepared_at: string;
  container_id: string | null;
  bound_at: string | null;
  started_at: string | null;
  stopped: VerifiedStopped | null;
  observation: AttemptObservation | null;
  accounting: AccountingObservation | null;
}
export interface BlockProjection {
  activation: BlockActivation;
  excluded: string | null;
  validity_receipt: Payload<'block_validated'> | null;
  invalidation: Payload<'block_invalidated'> | null;
}
export interface CampaignProjection {
  experiment: Experiment;
  registered: boolean;
  start: ExecutionStart | null;
  controller: ProcessIdentity | null;
  attempts: Map<string, AttemptProjection>;
  blocks: Map<string, BlockProjection>;
  selected_blocks: Map<string, string>;
  exhausted_blocks: Map<string, ReplacementCause>;
  consumed_reserves: Set<string>;
  transitions: Map<string, string>;
  last_at: string | null;
  ended: Payload<'ended'> | null;
  termination: Payload<'termination_verified'> | null;
}
export function initialProjection(experiment: Experiment): CampaignProjection {
  return {
    experiment: ExperimentSchema.parse(experiment),
    registered: false,
    start: null,
    controller: null,
    attempts: new Map(),
    blocks: new Map(),
    selected_blocks: new Map(),
    exhausted_blocks: new Map(),
    consumed_reserves: new Set(),
    transitions: new Map(),
    last_at: null,
    ended: null,
    termination: null,
  };
}
function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(`campaign transition refused: ${message}`);
}
function cloneProjection(state: CampaignProjection): CampaignProjection {
  // Nested records are replaced, never mutated. Only projection maps/sets are writable.
  return {
    ...state,
    attempts: new Map(state.attempts),
    blocks: new Map(state.blocks),
    selected_blocks: new Map(state.selected_blocks),
    exhausted_blocks: new Map(state.exhausted_blocks),
    consumed_reserves: new Set(state.consumed_reserves),
    transitions: new Map(state.transitions),
  };
}
function live(state: CampaignProjection) {
  requireCondition(
    state.controller && !state.ended,
    'a bound live controller is required',
  );
}
function attempt(state: CampaignProjection, id: string) {
  const found = state.attempts.get(id);
  requireCondition(found, `unknown attempt ${id}`);
  return found;
}
function block(state: CampaignProjection, id: string) {
  const found = state.blocks.get(id);
  requireCondition(found, `unknown block ${id}`);
  return found;
}
function members(state: CampaignProjection, b: BlockProjection) {
  return b.activation.attempts.map((intent) =>
    attempt(state, intent.identity.execution_attempt_id),
  );
}
function sameIdentity(
  state: CampaignProjection,
  identity: { campaign_id: string; input_digest: string },
) {
  requireCondition(
    identity.campaign_id === state.experiment.campaign_id &&
      identity.input_digest === state.experiment.input_digest,
    'experiment identity mismatch',
  );
}
function timeWithin(time: string, floor: string, ceiling: string) {
  requireCondition(
    Date.parse(time) >= Date.parse(floor) &&
      Date.parse(time) <= Date.parse(ceiling),
    'observation timestamp is outside its execution window',
  );
}
function death(a: AttemptProjection, stopped: VerifiedStopped, at: string) {
  requireCondition(
    stopped.execution_attempt_id === a.intent.identity.execution_attempt_id,
    'death proof belongs to another attempt',
  );
  requireCondition(
    stopped.container_id === a.container_id,
    'death proof container identity mismatch',
  );
  if (a.container_id !== null)
    requireCondition(
      stopped.proof !== 'never_created',
      'bound worker cannot be never created',
    );
  timeWithin(
    stopped.observed_at,
    a.stopped?.observed_at ?? a.started_at ?? a.bound_at ?? a.prepared_at,
    at,
  );
}
function artifacts(artifacts: { path: string }[], missing: string | null) {
  requireCondition(
    artifacts.length > 0 || missing !== null,
    'empty evidence requires explicit missingness',
  );
  requireCondition(
    new Set(artifacts.map((ref) => ref.path)).size === artifacts.length,
    'duplicate artifact path',
  );
}
function replaceable(
  state: CampaignProjection,
  b: BlockProjection,
  reason: ReplacementCause,
) {
  requireCondition(
    members(state, b).every((a) => a.stopped !== null),
    'all predecessor workers must be verified stopped',
  );
  const instrument = members(state, b).some(
    (a) =>
      a.observation?.failure_class === 'instrument' &&
      a.observation.cause === reason,
  );
  requireCondition(
    instrument || b.excluded === reason,
    'replacement requires an observed typed cause or committed invalidation',
  );
}
function allowance(state: CampaignProjection, b: BlockProjection) {
  const first = state.experiment.planned_slots.find(
    (s) => s.primary_block_id === b.activation.primary_block_id,
  );
  requireCondition(first, 'block lacks primary slot');
  return (
    members(state, b).every(
      (a) =>
        a.intent.attempt_number <
        state.experiment.suite.attempt_bounds.max_attempts,
    ) &&
    state.experiment.reserve_slots.some(
      (r) =>
        r.comparison_id === first.comparison_id &&
        r.scenario === first.scenario &&
        !state.consumed_reserves.has(r.reserve_id),
    )
  );
}
function activate(
  state: CampaignProjection,
  activation: BlockActivation,
  at: string,
  predecessor: BlockProjection | null,
) {
  live(state);
  requireCondition(
    !state.blocks.has(activation.block_id),
    'block identity already activated',
  );
  requireCondition(
    !state.exhausted_blocks.has(activation.primary_block_id),
    'primary block is exhausted',
  );
  const slots = state.experiment.planned_slots.filter(
    (s) => s.primary_block_id === activation.primary_block_id,
  );
  requireCondition(
    slots.length > 0 && slots.length === activation.attempts.length,
    'activation must contain all primary slots',
  );
  const seen = new Set<string>();
  const ids = new Set<string>();
  const names = new Set(
    [...state.attempts.values()].map((a) => a.intent.container_name),
  );
  const roots = new Set(
    [...state.attempts.values()].map((a) => a.intent.output_root),
  );
  for (const intent of activation.attempts) {
    const identity = intent.identity;
    const slot = slots.find((s) => s.sample_id === identity.sample_id);
    requireCondition(
      slot && !seen.has(slot.sample_id),
      'unknown or repeated primary slot',
    );
    requireCondition(
      identity.campaign_id === state.experiment.campaign_id &&
        identity.comparison_id === slot.comparison_id &&
        identity.block_id === activation.block_id &&
        intent.primary_block_id === activation.primary_block_id,
      'attempt identity differs from frozen slot',
    );
    requireCondition(
      !state.attempts.has(identity.execution_attempt_id) &&
        !ids.has(identity.execution_attempt_id),
      'duplicate attempt identity',
    );
    const previous = predecessor?.activation.attempts.find(
      (a) => a.identity.sample_id === slot.sample_id,
    );
    requireCondition(
      intent.attempt_number === (previous?.attempt_number ?? 0) + 1 &&
        intent.attempt_number <=
          state.experiment.suite.attempt_bounds.max_attempts,
      'attempt ordinal exceeds slot allowance',
    );
    requireCondition(
      !names.has(intent.container_name) && !roots.has(intent.output_root),
      'attempt runtime location must be unique',
    );
    requireCondition(
      intent.runtime_spec_digest ===
        sha256Hex(jcsCanonicalize(intent.runtime_spec)),
      'runtime specification digest mismatch',
    );
    requireCondition(
      intent.runtime_spec.max_time_s ===
        state.experiment.runtime_limits.max_time_s,
      'runtime deadline differs from frozen limit',
    );
    seen.add(slot.sample_id);
    ids.add(identity.execution_attempt_id);
    names.add(intent.container_name);
    roots.add(intent.output_root);
  }
  if (predecessor) {
    requireCondition(
      activation.predecessor_block_id === predecessor.activation.block_id &&
        predecessor.activation.primary_block_id === activation.primary_block_id,
      'successor predecessor mismatch',
    );
    requireCondition(
      activation.reserve_id !== null &&
        !state.consumed_reserves.has(activation.reserve_id),
      'reserve already used or absent',
    );
    const reserve = state.experiment.reserve_slots.find(
      (r) => r.reserve_id === activation.reserve_id,
    );
    requireCondition(
      reserve &&
        reserve.comparison_id === slots[0]?.comparison_id &&
        reserve.scenario === slots[0]?.scenario,
      'reserve belongs to another cell',
    );
    requireCondition(
      allowance(state, predecessor),
      'replacement allowance exhausted',
    );
    state.consumed_reserves.add(activation.reserve_id);
  } else {
    requireCondition(
      !state.selected_blocks.has(activation.primary_block_id),
      'primary already selected',
    );
    requireCondition(
      activation.reserve_id === null &&
        activation.predecessor_block_id === null &&
        activation.block_id === activation.primary_block_id,
      'initial activation is not its primary block',
    );
  }
  for (const intent of activation.attempts)
    state.attempts.set(intent.identity.execution_attempt_id, {
      intent,
      prepared_at: at,
      container_id: null,
      bound_at: null,
      started_at: null,
      stopped: null,
      observation: null,
      accounting: null,
    });
  state.blocks.set(activation.block_id, {
    activation,
    excluded: null,
    validity_receipt: null,
    invalidation: null,
  });
  state.selected_blocks.set(activation.primary_block_id, activation.block_id);
}
function applyValidatedTransition(
  state: CampaignProjection,
  t: CampaignTransition,
) {
  requireCondition(!state.termination, 'campaign is terminated');
  requireCondition(
    state.last_at === null || Date.parse(t.at) >= Date.parse(state.last_at),
    'transition timestamp moved backwards',
  );
  requireCondition(
    state.registered || t.type === 'registered',
    'first transition must register the experiment',
  );
  if (state.ended)
    requireCondition(
      t.type === 'accounting_observed' || t.type === 'termination_verified',
      'ended outcome is immutable',
    );
  switch (t.type) {
    case 'registered':
      requireCondition(
        !state.registered && state.transitions.size === 0,
        'registration must be first and sole',
      );
      sameIdentity(state, t.payload);
      state.registered = true;
      break;
    case 'started':
      requireCondition(
        state.start === null,
        'start authorization already consumed',
      );
      sameIdentity(state, t.payload);
      timeWithin(t.payload.claimed_at, state.experiment.registered_at, t.at);
      state.start = t.payload;
      break;
    case 'controller_bound':
      requireCondition(
        state.start?.start_id === t.payload.start_id,
        'controller start mismatch',
      );
      requireCondition(
        state.controller === null ||
          jcsCanonicalize(state.controller) ===
            jcsCanonicalize(t.payload.controller),
        'controller cannot be replaced',
      );
      state.controller = t.payload.controller;
      break;
    case 'block_activated':
      activate(state, t.payload, t.at, null);
      break;
    case 'block_replaced': {
      live(state);
      const activation = t.payload.activation;
      requireCondition(
        activation.predecessor_block_id !== null &&
          state.selected_blocks.get(activation.primary_block_id) ===
            activation.predecessor_block_id,
        'predecessor is not selected',
      );
      const predecessor = block(state, activation.predecessor_block_id);
      replaceable(state, predecessor, t.payload.reason);
      activate(state, activation, t.at, predecessor);
      state.blocks.set(predecessor.activation.block_id, {
        ...predecessor,
        excluded: predecessor.excluded ?? t.payload.reason,
      });
      break;
    }
    case 'runtime_bound': {
      live(state);
      const a = attempt(state, t.payload.execution_attempt_id);
      requireCondition(
        a.container_id === null &&
          !a.stopped &&
          !a.observation &&
          !a.accounting,
        'only a prepared attempt may bind',
      );
      requireCondition(
        a.intent.runtime_spec_digest === t.payload.runtime_spec_digest,
        'runtime binding digest mismatch',
      );
      requireCondition(
        ![...state.attempts.values()].some(
          (other) => other.container_id === t.payload.container_id,
        ),
        'container already bound',
      );
      state.attempts.set(t.payload.execution_attempt_id, {
        ...a,
        container_id: t.payload.container_id,
        bound_at: t.at,
      });
      break;
    }
    case 'runtime_started': {
      live(state);
      const a = attempt(state, t.payload.execution_attempt_id);
      requireCondition(
        a.container_id && a.bound_at && !a.started_at && !a.stopped,
        'runtime start requires an open bound attempt',
      );
      timeWithin(t.payload.observed_at, a.bound_at, t.at);
      state.attempts.set(t.payload.execution_attempt_id, {
        ...a,
        started_at: t.payload.observed_at,
      });
      break;
    }
    case 'attempt_observed': {
      live(state);
      const obs = t.payload.observation;
      const a = attempt(state, obs.execution_attempt_id);
      requireCondition(
        a.observation === null,
        'accepted observation is immutable',
      );
      death(a, obs.stopped, t.at);
      artifacts(obs.artifacts, obs.evidence_missing);
      const b = block(state, a.intent.identity.block_id);
      requireCondition(
        state.selected_blocks.get(a.intent.primary_block_id) ===
          b.activation.block_id,
        'cannot accept unselected predecessor behavior',
      );
      if (obs.validity !== 'valid')
        requireCondition(
          t.payload.excluded_block !== null,
          'invalid or unknown validity must exclude the block atomically',
        );
      if (t.payload.excluded_block) {
        requireCondition(
          t.payload.excluded_block.block_id === b.activation.block_id &&
            obs.validity !== 'valid',
          'companion exclusion must match invalid observation',
        );
        state.blocks.set(b.activation.block_id, {
          ...b,
          excluded: b.excluded ?? t.payload.excluded_block.reason,
        });
      }
      state.attempts.set(obs.execution_attempt_id, {
        ...a,
        stopped: obs.stopped,
        observation: obs,
      });
      break;
    }
    case 'accounting_observed': {
      const a = attempt(state, t.payload.execution_attempt_id);
      requireCondition(
        a.accounting === null,
        'accounting observation is immutable',
      );
      death(a, t.payload.stopped, t.at);
      artifacts(t.payload.artifacts, t.payload.evidence_missing);
      state.attempts.set(t.payload.execution_attempt_id, {
        ...a,
        stopped: t.payload.stopped,
        accounting: t.payload,
      });
      break;
    }
    case 'block_validated': {
      live(state);
      const b = block(state, t.payload.block_id);
      requireCondition(
        !b.excluded &&
          !b.validity_receipt &&
          members(state, b).every(
            (a) => a.observation !== null && a.observation.validity === 'valid',
          ),
        'positive audit requires closed valid member observations and no exclusion',
      );
      state.blocks.set(t.payload.block_id, {
        ...b,
        validity_receipt: t.payload,
      });
      break;
    }
    case 'block_invalidated': {
      live(state);
      const b = block(state, t.payload.block_id);
      requireCondition(!b.invalidation, 'validity audit is immutable');
      state.blocks.set(t.payload.block_id, {
        ...b,
        excluded: b.excluded ?? t.payload.reason,
        invalidation: t.payload,
      });
      break;
    }
    case 'block_exhausted': {
      live(state);
      const selected = state.selected_blocks.get(t.payload.primary_block_id);
      requireCondition(
        selected && !state.exhausted_blocks.has(t.payload.primary_block_id),
        'exhaustion requires selected unresolved block',
      );
      const b = block(state, selected);
      replaceable(state, b, t.payload.reason);
      requireCondition(!allowance(state, b), 'a legal replacement remains');
      state.blocks.set(selected, {
        ...b,
        excluded: b.excluded ?? t.payload.reason,
      });
      state.exhausted_blocks.set(t.payload.primary_block_id, t.payload.reason);
      break;
    }
    case 'ended': {
      requireCondition(state.start, 'session must start before ending');
      if (t.payload.outcome !== 'interrupted')
        requireCondition(
          [...state.attempts.values()].every((a) => a.stopped),
          'all workers must be verified stopped',
        );
      requireCondition(
        (t.payload.outcome === 'cancelled') ===
          (t.payload.cancel_intent !== null),
        'ordinary cancellation requires its intent reference',
      );
      if (t.payload.outcome === 'completed') {
        live(state);
        for (const primary of new Set(
          state.experiment.planned_slots.map((s) => s.primary_block_id),
        )) {
          const selected = state.selected_blocks.get(primary);
          requireCondition(selected, 'all planned blocks must be resolved');
          const b = block(state, selected);
          requireCondition(
            state.exhausted_blocks.has(primary) ||
              (b.validity_receipt && !b.excluded),
            'selected block lacks final validity receipt',
          );
        }
      }
      state.ended = t.payload;
      break;
    }
    case 'termination_verified': {
      requireCondition(
        state.ended && state.start?.start_id === t.payload.start_id,
        'termination requires matching ended start',
      );
      requireCondition(
        t.payload.stopped.length === state.attempts.size &&
          new Set(t.payload.stopped.map((s) => s.execution_attempt_id)).size ===
            state.attempts.size,
        'termination needs complete exact intent inventory',
      );
      for (const stopped of t.payload.stopped) {
        const a = attempt(state, stopped.execution_attempt_id);
        death(a, stopped, t.at);
        state.attempts.set(stopped.execution_attempt_id, { ...a, stopped });
      }
      state.termination = t.payload;
      break;
    }
    default: {
      const exhaustive: never = t;
      throw new Error(`unknown transition ${exhaustive}`);
    }
  }
}
/** The sole replay policy. IO authentication must finish before calling this fold. */
export function foldTransition(
  state: CampaignProjection,
  transition: CampaignTransition,
): CampaignProjection {
  const parsed = CampaignTransitionSchema.parse(transition);
  const canonical = jcsCanonicalize(parsed);
  const previous = state.transitions.get(parsed.transition_id);
  if (previous !== undefined) {
    requireCondition(
      previous === canonical,
      'transition id has different canonical bytes',
    );
    return cloneProjection(state);
  }
  const next = cloneProjection(state);
  applyValidatedTransition(next, parsed);
  next.transitions.set(parsed.transition_id, canonical);
  next.last_at = parsed.at;
  return next;
}
