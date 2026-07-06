// check/transcript-dispatch.ts — run one transcript verb, returning a
// CheckOutcome instead of exiting. Shared by:
//   - src/cli/check-transcript.ts (the `check-transcript <verb>` CLI), and
//   - src/check/dispatch.ts's runVerb (so `not check-transcript <verb>` can run
//     the inner verb in-process with the same arity/usage gates).
//
// A usage error / unknown verb / missing arg / keyless matcher returns
// {broken:true}. The CLI maps that to the non-invertible 127 band; negate maps
// it to "refuse to invert a crash". This keeps the broken-check spine identical
// to the original check-transcript.ts dispatch.

import type { ToolCallView } from '../atif/project.ts';
import type { CheckOutcome } from './fs-verbs.ts';
import {
  verbImplementationToolNotCalled,
  verbInvestigated,
  verbSkillBeforeImplementationTool,
  verbSkillBeforeTool,
  verbSkillCalled,
  verbSkillNotCalled,
  verbToolArgMatch,
  verbToolBefore,
  verbToolCalled,
  verbToolCount,
  verbToolMatchBeforeToolMatch,
  verbToolNotCalled,
  verbWorktreeCreated,
} from './verbs.ts';

// Minimum required positional args per verb. A missing arg must NOT silently
// pass: e.g. `skill-before-tool <skill>` with no <tool> would set tool="",
// match nothing, and vacuously pass. Arity is validated before dispatch and
// routes through the broken (non-invertible) path.
const REQUIRED_ARGS: Record<string, number> = {
  'tool-called': 1,
  'tool-not-called': 1,
  'tool-count': 3,
  'tool-before': 2,
  'skill-called': 1,
  'skill-not-called': 1,
  'skill-before-tool': 2,
  'skill-before-implementation-tool': 2,
  'implementation-tool-not-called': 1,
  investigated: 0,
  'worktree-created': 0,
  'tool-match-before-tool-match': 4,
};

// The full transcript-verb vocabulary, for static validation (quorum check).
// Derived from REQUIRED_ARGS (every verb with an arity entry) plus
// tool-arg-match, whose arity is option-shaped and validated separately above.
export const TRANSCRIPT_VERBS: ReadonlySet<string> = new Set([
  ...Object.keys(REQUIRED_ARGS),
  'tool-arg-match',
]);

function ok(passed: boolean, detail: string): CheckOutcome {
  return { passed, detail };
}
function broken(detail: string): CheckOutcome {
  return { passed: false, detail, broken: true };
}

/**
 * Run a transcript verb against the flattened calls. Returns a CheckOutcome:
 * `broken:true` for usage errors / unknown verbs / missing args / keyless
 * matchers; otherwise an honest pass/fail.
 */
export function transcriptOutcome(
  verb: string,
  args: string[],
  calls: ToolCallView[],
  empty: boolean,
): CheckOutcome {
  if (!verb) {
    return broken('usage: check-transcript <verb> [args...]');
  }

  try {
    return dispatchInner(verb, args, calls, empty);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return broken(`tool error: ${message}`);
  }
}

function dispatchInner(
  verb: string,
  args: string[],
  calls: ToolCallView[],
  empty: boolean,
): CheckOutcome {
  const need = REQUIRED_ARGS[verb];
  if (need !== undefined && args.length < need) {
    return broken(
      `check-transcript ${verb}: expected ${need} argument(s), got ${args.length}`,
    );
  }
  if (
    verb === 'tool-arg-match' &&
    (args.length < 1 || !args.some((a) => a === '--eq' || a === '--matches'))
  ) {
    return broken(
      'check-transcript tool-arg-match: needs <tool> and at least one --eq/--matches',
    );
  }
  // Each --eq/--matches must be followed by a well-formed `key=value` spec: a
  // missing or keyless spec parses to {keys:[], expected:''}, which matches
  // every call → silent pass. Reject it as a broken (non-invertible) check.
  if (verb === 'tool-arg-match') {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--eq' || args[i] === '--matches') {
        const spec = args[i + 1] ?? '';
        const eqIdx = spec.indexOf('=');
        const keyPart = eqIdx >= 0 ? spec.slice(0, eqIdx) : '';
        const keys = keyPart
          .split(',')
          .map((k) => k.trim())
          .filter((k) => k.length > 0);
        if (eqIdx < 0 || keys.length === 0) {
          return broken(
            `check-transcript tool-arg-match: ${args[i]} needs a key=value spec with a non-empty key`,
          );
        }
      }
    }
  }

  switch (verb) {
    case 'tool-called': {
      const r = verbToolCalled(calls, empty, args);
      return ok(r.passed, r.detail);
    }
    case 'tool-not-called': {
      const r = verbToolNotCalled(calls, empty, args);
      return ok(r.passed, r.detail);
    }
    case 'tool-count': {
      const r = verbToolCount(calls, empty, args);
      if (r === null) {
        return broken(
          `Unknown operator: ${args[1] ?? ''} (expected: eq, gt, gte, lt, lte)`,
        );
      }
      return ok(r.passed, r.detail);
    }
    case 'tool-before': {
      const r = verbToolBefore(calls, empty, args);
      return ok(r.passed, r.detail);
    }
    case 'skill-called': {
      const r = verbSkillCalled(calls, empty, args);
      return ok(r.passed, r.detail);
    }
    case 'skill-not-called': {
      const r = verbSkillNotCalled(calls, empty, args);
      return ok(r.passed, r.detail);
    }
    case 'skill-before-tool': {
      const r = verbSkillBeforeTool(calls, empty, args);
      return ok(r.passed, r.detail);
    }
    case 'skill-before-implementation-tool': {
      const r = verbSkillBeforeImplementationTool(calls, empty, args);
      return ok(r.passed, r.detail);
    }
    case 'implementation-tool-not-called': {
      const r = verbImplementationToolNotCalled(calls, empty, args);
      return ok(r.passed, r.detail);
    }
    case 'investigated': {
      const r = verbInvestigated(calls, empty, args);
      return ok(r.passed, r.detail);
    }
    case 'worktree-created': {
      const r = verbWorktreeCreated(calls, empty, args);
      return ok(r.passed, r.detail);
    }
    case 'tool-match-before-tool-match': {
      const r = verbToolMatchBeforeToolMatch(calls, empty, args);
      return ok(r.passed, r.detail);
    }
    case 'tool-arg-match': {
      const r = verbToolArgMatch(calls, empty, args);
      return ok(r.passed, r.detail);
    }
    default:
      return broken(`check-transcript: unknown verb '${verb}'`);
  }
}
