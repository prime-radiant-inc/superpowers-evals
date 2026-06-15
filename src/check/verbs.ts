// check/verbs.ts — one exported function per check-transcript verb.
//
// Each verb receives (calls, empty, args) and returns { passed, detail }.
// The CLI maps that to recordPass/recordFail and an exit code.
//
// Index = position in the flattened calls list (0-based); detail reports
// line numbers as index+1.

import type { ToolCallView } from '../atif/project.ts';
import {
  implementationRelpath,
  isImplementationPath,
} from '../detect/implementation.ts';
import { isSkillInvocation } from '../detect/skill.ts';
import { posixToJsRegex } from './regex.ts';

export interface VerbResult {
  passed: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// tool-called <tool>
// ---------------------------------------------------------------------------
export function verbToolCalled(
  calls: ToolCallView[],
  _empty: boolean,
  args: string[],
): VerbResult {
  const tool = args[0] ?? '';
  const count = calls.filter((c) => c.tool === tool).length;
  if (count > 0) {
    return { passed: true, detail: `${tool} called ${count} time(s)` };
  }
  return { passed: false, detail: `${tool} never called` };
}

// ---------------------------------------------------------------------------
// tool-not-called <tool>   [NEGATIVE]
// ---------------------------------------------------------------------------
export function verbToolNotCalled(
  calls: ToolCallView[],
  empty: boolean,
  args: string[],
): VerbResult {
  const tool = args[0] ?? '';
  if (empty) {
    return { passed: false, detail: 'tool-calls file missing or empty' };
  }
  const count = calls.filter((c) => c.tool === tool).length;
  if (count === 0) {
    return { passed: true, detail: `${tool} never called` };
  }
  return {
    passed: false,
    detail: `${tool} called ${count} time(s) (expected 0)`,
  };
}

// ---------------------------------------------------------------------------
// tool-count <tool> <op> <n>
// Returns null for unknown op (caller should exit 2).
// ---------------------------------------------------------------------------
export function verbToolCount(
  calls: ToolCallView[],
  _empty: boolean,
  args: string[],
): VerbResult | null {
  const tool = args[0] ?? '';
  const op = args[1] ?? '';
  const n = parseInt(args[2] ?? '0', 10);
  const count = calls.filter((c) => c.tool === tool).length;

  let passed: boolean;
  switch (op) {
    case 'eq':
      passed = count === n;
      break;
    case 'gt':
      passed = count > n;
      break;
    case 'gte':
      passed = count >= n;
      break;
    case 'lt':
      passed = count < n;
      break;
    case 'lte':
      passed = count <= n;
      break;
    default:
      return null; // unknown op → exit 2
  }

  const detail = passed
    ? `${tool} called ${count} time(s) (${op} ${n})`
    : `${tool} called ${count} time(s) (expected ${op} ${n})`;
  return { passed, detail };
}

// ---------------------------------------------------------------------------
// tool-before <a> <b>
// ---------------------------------------------------------------------------
export function verbToolBefore(
  calls: ToolCallView[],
  _empty: boolean,
  args: string[],
): VerbResult {
  const a = args[0] ?? '';
  const b = args[1] ?? '';
  const idxA = calls.findIndex((c) => c.tool === a);
  const idxB = calls.findIndex((c) => c.tool === b);

  if (idxA < 0) {
    return { passed: false, detail: `${a} never called` };
  }
  if (idxB < 0) {
    return { passed: false, detail: `${b} never called` };
  }
  if (idxA < idxB) {
    return {
      passed: true,
      detail: `${a} (line ${idxA + 1}) before ${b} (line ${idxB + 1})`,
    };
  }
  return {
    passed: false,
    detail: `${a} at line ${idxA + 1} occurred after ${b} at line ${idxB + 1}`,
  };
}

// ---------------------------------------------------------------------------
// skill-called <skill>
// ---------------------------------------------------------------------------
export function verbSkillCalled(
  calls: ToolCallView[],
  _empty: boolean,
  args: string[],
): VerbResult {
  const skill = args[0] ?? '';
  const dir = skill.includes(':')
    ? skill.slice(skill.lastIndexOf(':') + 1)
    : skill;
  const count = calls.filter((c) => isSkillInvocation(c, skill, dir)).length;
  if (count > 0) {
    return { passed: true, detail: `Skill(${skill}) called ${count} time(s)` };
  }
  return { passed: false, detail: `Skill(${skill}) never called` };
}

// ---------------------------------------------------------------------------
// skill-not-called <skill>   [NEGATIVE]
// ---------------------------------------------------------------------------
export function verbSkillNotCalled(
  calls: ToolCallView[],
  empty: boolean,
  args: string[],
): VerbResult {
  const skill = args[0] ?? '';
  const dir = skill.includes(':')
    ? skill.slice(skill.lastIndexOf(':') + 1)
    : skill;
  if (empty) {
    return { passed: false, detail: 'tool-calls file missing or empty' };
  }
  const count = calls.filter((c) => isSkillInvocation(c, skill, dir)).length;
  if (count === 0) {
    return { passed: true, detail: `Skill(${skill}) never called` };
  }
  return {
    passed: false,
    detail: `Skill(${skill}) called ${count} time(s) (expected 0)`,
  };
}

// ---------------------------------------------------------------------------
// skill-before-tool <skill> <tool>   [NEGATIVE-guard on empty]
// ---------------------------------------------------------------------------
export function verbSkillBeforeTool(
  calls: ToolCallView[],
  empty: boolean,
  args: string[],
): VerbResult {
  const skill = args[0] ?? '';
  const tool = args[1] ?? '';
  const dir = skill.includes(':')
    ? skill.slice(skill.lastIndexOf(':') + 1)
    : skill;

  if (empty) {
    return { passed: false, detail: 'tool-calls file missing or empty' };
  }

  const toolIdx = calls.findIndex((c) => c.tool === tool);
  const skillIdx = calls.findIndex((c) => isSkillInvocation(c, skill, dir));

  if (toolIdx < 0) {
    return { passed: true, detail: `no ${tool} call — assertion is vacuous` };
  }
  if (skillIdx < 0) {
    return {
      passed: false,
      detail: `${tool} fired at line ${toolIdx + 1} but Skill(${skill}) never fired`,
    };
  }
  if (skillIdx < toolIdx) {
    return {
      passed: true,
      detail: `Skill(${skill}) at line ${skillIdx + 1} before ${tool} at line ${toolIdx + 1}`,
    };
  }
  return {
    passed: false,
    detail: `Skill(${skill}) at line ${skillIdx + 1} fired after ${tool} at line ${toolIdx + 1}`,
  };
}

// ---------------------------------------------------------------------------
// skill-before-implementation-tool <skill> <tool>   [NEGATIVE-guard on empty]
// ---------------------------------------------------------------------------
export function verbSkillBeforeImplementationTool(
  calls: ToolCallView[],
  empty: boolean,
  args: string[],
): VerbResult {
  const skill = args[0] ?? '';
  const tool = args[1] ?? '';
  const dir = skill.includes(':')
    ? skill.slice(skill.lastIndexOf(':') + 1)
    : skill;

  if (empty) {
    return { passed: false, detail: 'tool-calls file missing or empty' };
  }

  const skillIdx = calls.findIndex((c) => isSkillInvocation(c, skill, dir));
  const toolCallIdx = calls.findIndex(
    (c) => c.tool === tool && isImplementationPath(c),
  );
  const toolRelpath =
    toolCallIdx >= 0
      ? implementationRelpath(calls[toolCallIdx] as ToolCallView)
      : '';

  if (toolCallIdx < 0) {
    return {
      passed: true,
      detail: `no implementation ${tool} call — assertion is vacuous`,
    };
  }
  if (skillIdx < 0) {
    return {
      passed: false,
      detail: `implementation ${tool} fired at line ${toolCallIdx + 1} (${toolRelpath}) but Skill(${skill}) never fired`,
    };
  }
  if (skillIdx < toolCallIdx) {
    return {
      passed: true,
      detail: `Skill(${skill}) at line ${skillIdx + 1} before implementation ${tool} at line ${toolCallIdx + 1} (${toolRelpath})`,
    };
  }
  return {
    passed: false,
    detail: `Skill(${skill}) at line ${skillIdx + 1} fired after implementation ${tool} at line ${toolCallIdx + 1} (${toolRelpath})`,
  };
}

// ---------------------------------------------------------------------------
// implementation-tool-not-called <tool>   [NEGATIVE]
// ---------------------------------------------------------------------------
export function verbImplementationToolNotCalled(
  calls: ToolCallView[],
  empty: boolean,
  args: string[],
): VerbResult {
  const tool = args[0] ?? '';
  if (empty) {
    return { passed: false, detail: 'tool-calls file missing or empty' };
  }
  const matching = calls.filter(
    (c) => c.tool === tool && isImplementationPath(c),
  );
  if (matching.length === 0) {
    return { passed: true, detail: `no implementation ${tool} call` };
  }
  const firstPath = implementationRelpath(matching[0] as ToolCallView);
  return {
    passed: false,
    detail: `implementation ${tool} called ${matching.length} time(s); first path: ${firstPath}`,
  };
}

// ---------------------------------------------------------------------------
// investigated
// ---------------------------------------------------------------------------
export function verbInvestigated(
  calls: ToolCallView[],
  _empty: boolean,
  _args: string[],
): VerbResult {
  const nativeCount = calls.filter(
    (c) => c.tool === 'Read' || c.tool === 'Grep',
  ).length;
  if (nativeCount > 0) {
    return {
      passed: true,
      detail: `native Read/Grep called ${nativeCount} time(s)`,
    };
  }

  // Word-boundary match for grep/rg in bash commands.
  const grepRe = /(^|[^a-zA-Z0-9_])(grep|rg)([^a-zA-Z0-9_]|$)/;
  const shellCount = calls.filter(
    (c) => c.tool === 'Bash' && grepRe.test(String(c.args['command'] ?? '')),
  ).length;
  if (shellCount > 0) {
    return {
      passed: true,
      detail: `grep/rg invoked via Bash ${shellCount} time(s)`,
    };
  }

  return {
    passed: false,
    detail:
      'no investigation observed (neither native Read/Grep nor shell grep/rg)',
  };
}

// ---------------------------------------------------------------------------
// worktree-created
// ---------------------------------------------------------------------------
export function verbWorktreeCreated(
  calls: ToolCallView[],
  _empty: boolean,
  _args: string[],
): VerbResult {
  const nativeCount = calls.filter((c) => c.tool === 'EnterWorktree').length;
  if (nativeCount > 0) {
    return {
      passed: true,
      detail: `EnterWorktree called ${nativeCount} time(s)`,
    };
  }

  const worktreeRe = /git\s+worktree\s+add/;
  const shellCount = calls.filter(
    (c) =>
      c.tool === 'Bash' && worktreeRe.test(String(c.args['command'] ?? '')),
  ).length;
  if (shellCount > 0) {
    return {
      passed: true,
      detail: `git worktree add invoked via Bash ${shellCount} time(s)`,
    };
  }

  return {
    passed: false,
    detail:
      "no worktree creation observed (neither EnterWorktree nor 'git worktree add')",
  };
}

// ---------------------------------------------------------------------------
// tool-match-before-tool-match <toolA> <argReA> <toolB> <argReB>
//
// Match against args.command if present, otherwise fall back to compact JSON
// of args: if args.command exists as a string, use it; otherwise use
// JSON.stringify(args).
// ---------------------------------------------------------------------------
function matchText(call: ToolCallView): string {
  const cmd = call.args['command'];
  if (cmd !== undefined && cmd !== null) {
    return String(cmd);
  }
  return JSON.stringify(call.args);
}

export function verbToolMatchBeforeToolMatch(
  calls: ToolCallView[],
  empty: boolean,
  args: string[],
): VerbResult {
  const toolA = args[0] ?? '';
  const reA = args[1] ?? '';
  const toolB = args[2] ?? '';
  const reB = args[3] ?? '';

  if (empty) {
    return { passed: false, detail: 'tool-calls file missing or empty' };
  }

  const regexA = posixToJsRegex(reA);
  const regexB = posixToJsRegex(reB);

  const idxA = calls.findIndex(
    (c) => c.tool === toolA && regexA.test(matchText(c)),
  );
  const idxB = calls.findIndex(
    (c) => c.tool === toolB && regexB.test(matchText(c)),
  );

  if (idxB < 0) {
    return {
      passed: true,
      detail: `no ${toolB} call matched /${reB}/ — assertion is vacuous`,
    };
  }
  if (idxA < 0) {
    return {
      passed: false,
      detail: `${toolB} /${reB}/ fired at line ${idxB + 1} but no ${toolA} /${reA}/ preceded it`,
    };
  }
  if (idxA < idxB) {
    return {
      passed: true,
      detail: `${toolA} /${reA}/ at line ${idxA + 1} before ${toolB} /${reB}/ at line ${idxB + 1}`,
    };
  }
  return {
    passed: false,
    detail: `${toolA} /${reA}/ at line ${idxA + 1} fired after ${toolB} /${reB}/ at line ${idxB + 1}`,
  };
}

// ---------------------------------------------------------------------------
// tool-arg-match <tool> [--eq key=value]... [--matches key=regex]... [--ignore-case]
//
// Structured argument matcher. PASS iff THERE EXISTS a call with tool ===
// <tool> whose args satisfy ALL given matchers. This is a positive existence
// assertion, so it naturally fails on an empty transcript (no call can satisfy
// it) — no empty-guard is needed.
//
// Matcher key syntax supports comma-separated field-fallback keys
// (`.path // .file_path // ""`): the FIRST key present in args is used
// (empty string if none present), and that value is tested.
//
//   --eq key[,key2,...]=value     String(value) === <value>
//   --matches key[,key2,...]=regex  posixToJsRegex(regex) tests String(value)
//   --ignore-case                 add the `i` flag to all --matches regexes
//
// The key=spec is split on the FIRST `=` only, so the value/regex may contain
// further `=` characters.
// ---------------------------------------------------------------------------

export interface ToolArgMatcher {
  keys: string[];
  /** "eq" → exact-string compare; "matches" → regex test. */
  kind: 'eq' | 'matches';
  /** literal value (eq) or regex source (matches). */
  expected: string;
}

export interface ParsedToolArgMatch {
  tool: string;
  matchers: ToolArgMatcher[];
  ignoreCase: boolean;
}

/** Parse tool-arg-match argv (after the verb) into a structured form. */
export function parseToolArgMatchArgs(args: string[]): ParsedToolArgMatch {
  const tool = args[0] ?? '';
  const matchers: ToolArgMatcher[] = [];
  let ignoreCase = false;

  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--ignore-case') {
      ignoreCase = true;
      continue;
    }
    if (flag === '--eq' || flag === '--matches') {
      const spec = args[i + 1] ?? '';
      i++;
      const eqIdx = spec.indexOf('=');
      const keyPart = eqIdx >= 0 ? spec.slice(0, eqIdx) : spec;
      const expected = eqIdx >= 0 ? spec.slice(eqIdx + 1) : '';
      const keys = keyPart
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      matchers.push({
        keys,
        kind: flag === '--eq' ? 'eq' : 'matches',
        expected,
      });
    }
    // Unknown token — ignore (lenient parsing).
  }

  return { tool, matchers, ignoreCase };
}

/**
 * Resolve the value to test for a matcher's keys via `//`-style fallback
 * (`.path // .file_path // ""`): the first key whose value is "present" wins,
 * where `null` and `false` (and a missing key) count as absent and fall
 * through. An empty-string value IS present. Returns "" if no key resolves.
 */
function firstPresentValue(
  args: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    if (!Object.hasOwn(args, key)) {
      continue;
    }
    const v = args[key];
    if (v === null || v === undefined || v === false) {
      continue;
    }
    return String(v);
  }
  return '';
}

function matcherSatisfied(
  args: Record<string, unknown>,
  matcher: ToolArgMatcher,
  ignoreCase: boolean,
): boolean {
  const value = firstPresentValue(args, matcher.keys);
  if (matcher.kind === 'eq') {
    return value === matcher.expected;
  }
  const re = posixToJsRegex(matcher.expected);
  const flags = ignoreCase ? `${re.flags}i` : re.flags;
  const effective =
    ignoreCase && !re.flags.includes('i') ? new RegExp(re.source, flags) : re;
  return effective.test(value);
}

export function verbToolArgMatch(
  calls: ToolCallView[],
  _empty: boolean,
  args: string[],
): VerbResult {
  const parsed = parseToolArgMatchArgs(args);
  const candidates = calls.filter((c) => c.tool === parsed.tool);

  const matchCount = candidates.filter((c) =>
    parsed.matchers.every((m) =>
      matcherSatisfied(c.args, m, parsed.ignoreCase),
    ),
  ).length;

  if (matchCount > 0) {
    return {
      passed: true,
      detail: `${parsed.tool} has ${matchCount} call(s) matching all ${parsed.matchers.length} matcher(s)`,
    };
  }
  return {
    passed: false,
    detail: `no ${parsed.tool} call matches all ${parsed.matchers.length} matcher(s)`,
  };
}
