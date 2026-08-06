import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeThreads } from '../src/seats/parse-claude.ts';
import {
  extractExecCommands,
  parseCodexThreads,
} from '../src/seats/parse-codex.ts';
import { appliedNoPatches } from '../src/seats/roles.ts';

// Fixtures are real recorded rows, trimmed: the Claude tree keeps the
// coding-agent-config/projects layout (the one 230 of the recorded runs use),
// and the Codex tree keeps home/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.

const FIXTURES = join(import.meta.dir, 'fixtures', 'seats');
const CLAUDE_RUN = join(
  FIXTURES,
  'sdd-report-formatter-claude-opus-linux-20260803T000000Z-aaaa',
);
const CODEX_RUN = join(
  FIXTURES,
  'sdd-report-formatter-codex-codex_sub-linux-20260803T000000Z-bbbb',
);

test('Claude: every thread becomes a seat, ordered by first timestamp', () => {
  const threads = parseClaudeThreads(CLAUDE_RUN);
  expect(threads.map((t) => t.role)).toEqual([
    'controller',
    'implementer',
    'task_reviewer',
    'final_reviewer',
  ]);
  expect(threads.map((t) => t.taskLabel)).toEqual([
    '',
    'Implement Task 1: User Report',
    'Review Task 1 (spec + quality)',
    'Final whole-branch review',
  ]);
  // The controller is the root: no parent, no spawn depth. Children join back
  // to it through meta.json.toolUseId, which matches the id of the controller's
  // Agent tool_use block.
  const [controller, implementer, reviewer, finalReviewer] = threads;
  expect(controller?.parentId).toBeNull();
  expect(controller?.spawnDepth).toBeNull();
  expect(implementer?.parentId).toBe(controller?.seatId);
  expect(reviewer?.parentId).toBe(controller?.seatId);
  expect(finalReviewer?.spawnDepth).toBe(1);
  // Per-thread models, not the run's model: the controller ran opus and
  // dispatched sonnet children.
  expect(controller?.models).toEqual(['claude-opus-4-8']);
  expect(implementer?.models).toEqual(['claude-sonnet-5']);
  expect(finalReviewer?.models).toEqual(['claude-opus-4-8']);
});

test('Claude: Write is a patch event and the implementer ran the full suite once', () => {
  const implementer = parseClaudeThreads(CLAUDE_RUN)[1];
  const patches = implementer?.events.filter((e) => e.kind === 'patch') ?? [];
  expect(patches.map((e) => e.tool)).toEqual(['Write']);
  const suiteRuns =
    implementer?.events.filter((e) => e.isSuiteRun === true) ?? [];
  expect(suiteRuns).toHaveLength(1);
  expect(suiteRuns[0]?.command).toBe('npm test');
  expect(suiteRuns[0]?.suiteScope).toBe('full');
  expect(suiteRuns[0]?.suiteFamilies).toEqual(['npm-test']);
  expect(appliedNoPatches(implementer?.events ?? [])).toBe(false);
});

test('Claude: the commit whose heredoc message says "npm test passes" is not a suite run', () => {
  const implementer = parseClaudeThreads(CLAUDE_RUN)[1];
  const commit = implementer?.events.find((e) =>
    e.command?.includes('git commit'),
  );
  expect(commit).toBeDefined();
  expect(commit?.command).toContain('npm test passes');
  expect(commit?.isSuiteRun).toBeUndefined();
});

test('Claude: a reviewer seat that only re-reads the report has 0 suite runs', () => {
  // The seat greps the report through Bash and opens the brief with the native
  // Read tool. Both are evidence reads; the Read of src/report.js is not, so a
  // source file merely named "report" does not inflate the count.
  const reviewer = parseClaudeThreads(CLAUDE_RUN)[2];
  expect(reviewer?.events.filter((e) => e.isSuiteRun === true)).toHaveLength(0);
  const reads = reviewer?.events.filter((e) => e.isEvidenceRead === true) ?? [];
  expect(reads.map((e) => e.tool)).toEqual(['Bash', 'Read']);
  expect(appliedNoPatches(reviewer?.events ?? [])).toBe(true);
});

test('Claude: the final reviewer re-ran the package suite and then a single file', () => {
  const finalReviewer = parseClaudeThreads(CLAUDE_RUN)[3];
  const suiteRuns =
    finalReviewer?.events.filter((e) => e.isSuiteRun === true) ?? [];
  expect(suiteRuns.map((e) => e.suiteScope)).toEqual(['full', 'focused']);
  expect(appliedNoPatches(finalReviewer?.events ?? [])).toBe(true);
});

test('Codex: threads become seats with roles from agent_path, controller first', () => {
  const threads = parseCodexThreads(CODEX_RUN);
  expect(threads.map((t) => t.role)).toEqual([
    'controller',
    'implementer',
    'task_reviewer',
    'final_reviewer',
  ]);
  expect(threads.map((t) => t.taskLabel)).toEqual([
    '',
    '/root/task1_implementer',
    '/root/task1_reviewer',
    '/root/final_review',
  ]);
  const [controller, implementer] = threads;
  expect(controller?.parentId).toBeNull();
  expect(controller?.spawnDepth).toBeNull();
  expect(implementer?.parentId).toBe(controller?.seatId);
  expect(implementer?.spawnDepth).toBe(1);
  // turn_context carries a per-thread model; the controller and its children
  // are not necessarily the same model.
  expect(controller?.models).toEqual(['gpt-5.6-sol']);
  expect(implementer?.models).toEqual(['gpt-5.6-luna']);
});

test('Codex: an apply_patch body quoting `node --test` is a patch, never a suite run', () => {
  // This is the dominant Codex false positive: the implementer writes its task
  // report through tools.apply_patch, and the report's TDD-evidence section
  // quotes the commands it ran. Regexing the raw exec payload counts those.
  const implementer = parseCodexThreads(CODEX_RUN)[1];
  const patchCall = implementer?.events.find((e) => e.tool === 'apply_patch');
  expect(patchCall).toBeDefined();
  expect(patchCall?.command).toBeUndefined();
  expect(patchCall?.isSuiteRun).toBeUndefined();
  // The mutation itself is recorded by the patch_apply_end event.
  expect(implementer?.events.filter((e) => e.kind === 'patch')).toHaveLength(1);
  expect(appliedNoPatches(implementer?.events ?? [])).toBe(false);
  // Exactly one real suite run on this seat, and it is not the patch or the
  // commit whose heredoc message also says "npm test passes".
  const suiteRuns =
    implementer?.events.filter((e) => e.isSuiteRun === true) ?? [];
  expect(suiteRuns).toHaveLength(1);
  expect(suiteRuns[0]?.command).toBe('npm test');
  expect(suiteRuns[0]?.suiteFamilies).toEqual(['npm-test']);
});

test('Codex: exec commands are extracted from the JS snippet, not regexed whole', () => {
  const reviewer = parseCodexThreads(CODEX_RUN)[2];
  const commands = reviewer?.events.map((e) => e.command) ?? [];
  expect(commands).toEqual([
    "sed -n '1,120p' .superpowers/sdd/report-plan/task-1-report.md",
    'git diff --check HEAD^',
  ]);
  expect(reviewer?.events.filter((e) => e.isSuiteRun === true)).toHaveLength(0);
  expect(
    reviewer?.events.filter((e) => e.isEvidenceRead === true),
  ).toHaveLength(1);
});

test('Codex: the final reviewer ran a package suite and a single-file suite', () => {
  const finalReviewer = parseCodexThreads(CODEX_RUN)[3];
  const suiteRuns =
    finalReviewer?.events.filter((e) => e.isSuiteRun === true) ?? [];
  expect(suiteRuns.map((e) => e.suiteFamilies?.[0])).toEqual([
    'npm-test',
    'node-test',
  ]);
  expect(suiteRuns.map((e) => e.suiteScope)).toEqual(['full', 'focused']);
});

test('Codex: exec snippets that batch commands through a cmds array are recovered', () => {
  // Real snippet from sdd-svelte-todo-codex-*: five verification commands run
  // through one exec call. The `{cmd, workdir}` shorthand means the object
  // literal has no cmd VALUE, so the array has to be read.
  const input = [
    'const wd="/workdir/.worktrees/svelte-todos";',
    'const cmds=["npm test","npm run check","npm run build","npx playwright test","git diff --check"];',
    'const rs=await Promise.all(cmds.map(cmd=>tools.exec_command({cmd,workdir:wd,yield_time_ms:30000})));',
  ].join('\n');
  const snippet = extractExecCommands(input);
  expect(snippet.commands).toEqual([
    'npm test',
    'npm run check',
    'npm run build',
    'npx playwright test',
    'git diff --check',
  ]);
});

test('Codex: an exec snippet that only applies a patch yields no commands', () => {
  const input = [
    'const patch = "*** Begin Patch\\n*** Update File: README.md\\n+Run `npm test` to verify.\\n*** End Patch\\n";',
    'const r = await tools.apply_patch({patch}); text(JSON.stringify(r));',
  ].join('\n');
  const snippet = extractExecCommands(input);
  expect(snippet.innerTools).toEqual(['apply_patch']);
  expect(snippet.commands).toEqual([]);
});

test('Codex: an exec snippet mixing a patch and a real command yields only the command', () => {
  const input = [
    'const patch = "*** Begin Patch\\n+3. Full suite: `npm test` exited 0.\\n*** End Patch\\n";',
    'await tools.apply_patch({patch});',
    'const r = await tools.exec_command({cmd:"go test ./...",workdir:"/w"});',
  ].join('\n');
  expect(extractExecCommands(input).commands).toEqual(['go test ./...']);
});

test('Codex: escaped newlines inside a cmd literal become real separators', () => {
  // Real snippet: several commands in one cmd string, separated by \n. The
  // prototype's raw-payload regex missed these because the character before
  // `npm` was the literal `n` of the escape sequence.
  const input =
    'const r = await tools.exec_command({cmd:"git diff --check\\nnpm test",workdir:"/w"});';
  expect(extractExecCommands(input).commands).toEqual([
    'git diff --check\nnpm test',
  ]);
});

test('a run dir with no logs of a dialect parses to no threads', () => {
  expect(parseCodexThreads(CLAUDE_RUN)).toEqual([]);
  expect(parseClaudeThreads(CODEX_RUN)).toEqual([]);
});

test('Codex: a thread whose CLI recorded no agent_path keeps its agent_role as label', () => {
  // Codex CLI 0.134.0 and 0.144.3 spawned subagents with agent_path: null and
  // only agent_role ("worker" / "default"). 968 recorded sdd seats look like
  // this. agent_role cannot tell a task reviewer from a final reviewer, so the
  // role stays `other` — but the raw label is preserved so downstream analysis
  // can see what the log did say instead of an opaque blank.
  const root = mkdtempSync(join(tmpdir(), 'seats-codex-'));
  const dir = join(root, 'home', '.codex', 'sessions', '2026', '06', '02');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'rollout-2026-06-02T14-52-21-019e8a52-c87d.jsonl'),
    `${JSON.stringify({
      timestamp: '2026-06-02T21:52:21.661Z',
      type: 'session_meta',
      payload: {
        id: '019e8a52-c87d-75b3-b0ee-5b9730439e08',
        cli_version: '0.134.0',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: '019e8a52-04ea-7bc3-8447-7108c0612274',
              depth: 1,
              agent_path: null,
              agent_nickname: 'Faraday',
              agent_role: 'worker',
            },
          },
        },
        thread_source: 'subagent',
      },
    })}\n`,
  );
  const [thread] = parseCodexThreads(root);
  expect(thread?.role).toBe('other');
  expect(thread?.taskLabel).toBe('agent_role:worker');
  expect(thread?.spawnDepth).toBe(1);
  expect(thread?.parentId).toBe('019e8a52-04ea-7bc3-8447-7108c0612274');
});
