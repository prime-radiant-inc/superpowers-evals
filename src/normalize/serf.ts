import type { AtifToolCall, AtifTrajectory } from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';
import { canonicalizeAgentPrompt } from './agent-prompt.ts';

// serf emits ATIF v1.7 natively (serf#8), so this normalizer is a
// near-passthrough: it parses serf's own export, canonicalizes tool names/args,
// and re-validates. It never rebuilds the trajectory from a raw session log.
//
// serf records native tool names in `function_name` (use_skill, delegate, bash,
// …). ATIF's `function_name` is free-form and Harbor preserves native names, so
// canonicalizing to quorum's cross-harness vocabulary is the consumer's job —
// the same contract every other quorum normalizer honors. serf's file/shell args
// already use canonical keys (file_path, content, command, pattern), so only the
// tool name and the two dispatch keys (Skill's `skill`, Agent's `prompt`) need
// aliasing.
const SERF_TOOL_MAP: Record<string, string> = {
  use_skill: 'Skill',
  delegate: 'Agent',
  bash: 'Bash',
  shell: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  apply_patch: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
};

// Canonicalize one serf tool call: remap the native function_name, then ADD the
// cross-harness dispatch arg aliases (Skill's `skill`, Agent's `prompt`). The
// native args survive untouched — we only add canonical keys.
function canonicalizeSerfToolCall(tc: AtifToolCall): AtifToolCall {
  const canonical = SERF_TOOL_MAP[tc.function_name] ?? tc.function_name;
  let next: AtifToolCall = { ...tc, function_name: canonical };

  if (canonical === 'Skill') {
    const raw = next.arguments['skill_name'];
    const skillName = typeof raw === 'string' ? raw : '';
    if (skillName) {
      next = {
        ...next,
        arguments: {
          ...next.arguments,
          // The transcript checks compare against the fully-qualified skill ref
          // (e.g. `superpowers:brainstorming`); serf emits it qualified already,
          // but prefix a bare name defensively.
          skill: skillName.includes(':')
            ? skillName
            : `superpowers:${skillName}`,
          name: skillName.split(':').slice(-1)[0] ?? skillName,
        },
      };
    }
  }

  if (canonical === 'Agent') {
    // serf's `delegate` carries the dispatch instruction under `task`; the shared
    // helper renames it to the canonical `prompt`.
    next = canonicalizeAgentPrompt(next);
  }

  return next;
}

function canonicalizeStepToolCalls(step: Record<string, unknown>): unknown {
  const toolCalls = step['tool_calls'];
  if (!Array.isArray(toolCalls)) {
    return step;
  }
  return {
    ...step,
    tool_calls: toolCalls.map((tc) =>
      tc !== null && typeof tc === 'object' && !Array.isArray(tc)
        ? canonicalizeSerfToolCall(tc as AtifToolCall)
        : tc,
    ),
  };
}

/**
 * Convert serf's native ATIF v1.7 export into quorum's canonical ATIF.
 *
 * serf already emits a valid ATIF-v1.7 document (root `schema_version`,
 * `agent`, `steps[]`), so we preserve the whole trajectory and only rewrite
 * tool-call names/args into the canonical vocabulary, then re-validate. A
 * non-JSON or non-conformant export is a fail-closed error (capture maps a
 * normalizer throw to indeterminate, never a silent pass). `version` is the
 * capture-supplied fallback; serf records its own `agent` block, which we keep.
 */
export function normalizeSerf(raw: string, version: string): AtifTrajectory {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('normalizeSerf: serf ATIF export is not valid JSON');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('normalizeSerf: serf ATIF export is not an object');
  }

  const obj = data as Record<string, unknown>;
  const steps = obj['steps'];
  if (!Array.isArray(steps)) {
    throw new Error('normalizeSerf: serf ATIF export has no steps array');
  }

  // Preserve serf's own agent block (its real name/build version); fall back to
  // the capture-supplied version only if serf omitted it.
  const agent =
    obj['agent'] !== null &&
    typeof obj['agent'] === 'object' &&
    !Array.isArray(obj['agent'])
      ? { name: 'serf', version, ...(obj['agent'] as Record<string, unknown>) }
      : { name: 'serf', version };

  const traj = {
    ...obj,
    agent,
    steps: steps.map((step) =>
      step !== null && typeof step === 'object' && !Array.isArray(step)
        ? canonicalizeStepToolCalls(step as Record<string, unknown>)
        : step,
    ),
  } as AtifTrajectory;

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeSerf produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}
