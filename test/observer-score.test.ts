import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { ObserverBinding } from '../src/experiments/observer/binding.ts';
import type {
  RawAnchor,
  RawSource,
} from '../src/experiments/observer/contracts.ts';
import { createRawPrefix } from '../src/experiments/observer/raw.ts';
import type {
  ActorReview,
  ArtifactReceipt,
} from '../src/experiments/observer/review.ts';
import { scoreObserverEvidence } from '../src/experiments/observer/score.ts';

const bytes = (rows: unknown[]) =>
  Buffer.from(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
const digest = (raw: Uint8Array) =>
  createHash('sha256').update(raw).digest('hex');
const at = (
  line: number,
  block: number | null = null,
  source_id = 'parent',
): RawAnchor => ({ source_id, line, block });
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture item');
  return value;
}
const message = (role: 'user' | 'assistant', text: string) => ({
  type: 'response_item',
  payload: {
    type: 'message',
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  },
});
const call = (id: string, command = 'write-file') => ({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'exec_command',
    call_id: id,
    arguments: JSON.stringify({ cmd: command }),
  },
});
const output = (id: string, success = true) => ({
  type: 'response_item',
  payload: {
    type: 'function_call_output',
    call_id: id,
    output: `Process exited with code ${success ? 0 : 1}`,
  },
});

// Synthetic adapter contract fixtures only: these are not native build qualification.
function fixture() {
  const source: RawSource = {
    source_id: 'parent',
    runtime: 'codex',
    expected_session_id: 'session',
    expected_cwd: '/fixture/workdir',
    expected_cli_version: '0.144.3',
  };
  const rows: unknown[] = [
    {
      type: 'session_meta',
      payload: {
        id: 'session',
        cwd: source.expected_cwd,
        cli_version: '0.144.3',
        source: 'cli',
        originator: 'codex-tui',
        thread_source: 'user',
      },
    },
    message('user', 'Build a todo list.'),
    message('assistant', 'What is it for?'),
    message('user', 'Learn React state and events, locally.'),
    message(
      'assistant',
      'Use one readable component for that learning exercise.',
    ),
    message('user', 'That design fits.'),
    call('spec'),
    output('spec'),
    message('assistant', 'Review the saved spec.'),
    message('user', 'I read and approve the spec.'),
    call('plan'),
    output('plan'),
    message('assistant', 'Review the saved plan.'),
    message('user', 'The plan is approved; execute inline.'),
    call('implementation'),
    output('implementation'),
  ];
  const binding: ObserverBinding = {
    schema_version: 2,
    run_id: 'run',
    campaign: null,
    runtime: 'codex',
    dialect: 'codex-response-items-0.144.3',
    cli_version: '0.144.3',
    home: '/fixture/home',
    workdir: '/fixture/workdir',
    launch_cwd: '/fixture/workdir',
    phase: 'finalized',
    parent_source_id: 'parent',
    roots: [
      {
        id: 'sessions',
        kind: 'transcripts',
        path: '/fixture/home/.codex/sessions',
      },
      { id: 'documents', kind: 'artifacts', path: '/fixture/workdir' },
    ],
    sources: [
      {
        source,
        root_id: 'sessions',
        relative_path: 'parent.jsonl',
        device: '1',
        inode: '2',
        parent_link: null,
      },
    ],
  };
  const review: ActorReview = {
    schema_version: 2,
    reviewer: 'synthetic contract review',
    stop_reason: 'endpoint',
    source_prefixes: [createRawPrefix(source, bytes(rows))],
    events: [
      {
        kind: 'understanding',
        anchor: at(5, 0),
        aligned: true,
        note: 'Purpose shapes scope.',
      },
      {
        kind: 'design_approval',
        anchor: at(6, 0),
        presented_anchor: at(5, 0),
        note: 'Design approved.',
      },
      {
        kind: 'artifact_approval',
        stage: 'spec',
        anchor: at(10, 0),
        presented_anchor: at(9, 0),
        receipt: 'spec',
        aligned: true,
        note: 'Saved spec reviewed.',
      },
      {
        kind: 'artifact_approval',
        stage: 'plan',
        anchor: at(14, 0),
        presented_anchor: at(13, 0),
        receipt: 'plan',
        aligned: true,
        note: 'Saved plan reviewed.',
      },
      {
        kind: 'execution_choice',
        anchor: at(14, 0),
        method: 'inline',
        note: 'Explicit method.',
      },
    ],
    actions: [
      {
        anchor: at(7),
        call_id: 'native:spec',
        effects: ['spec_write'],
        result_anchors: [at(8)],
        success: true,
        changed_artifacts: ['spec'],
        delegation: null,
        note: 'Spec saved.',
      },
      {
        anchor: at(11),
        call_id: 'native:plan',
        effects: ['plan_write'],
        result_anchors: [at(12)],
        success: true,
        changed_artifacts: ['plan'],
        delegation: null,
        note: 'Plan saved.',
      },
      {
        anchor: at(15),
        call_id: 'native:implementation',
        effects: ['implementation'],
        result_anchors: [at(16)],
        success: true,
        changed_artifacts: [],
        delegation: null,
        note: 'Scaffold succeeded.',
      },
    ],
  };
  const receipts: ArtifactReceipt[] = (['spec', 'plan'] as const).map(
    (stage) => {
      const content = Buffer.from(
        `${stage}: learn React state and events; local only`,
      );
      return {
        schema_version: 2,
        observation_id: stage,
        source_prefix: createRawPrefix(
          source,
          bytes(rows.slice(0, stage === 'spec' ? 9 : 13)),
        ),
        artifact_path: `docs/${stage}.md`,
        bytes: content.length,
        sha256: digest(content),
        content_base64: content.toString('base64'),
      };
    },
  );
  const input = () => ({
    raw_sources: [{ source_id: 'parent', bytes: bytes(rows) }],
    binding,
    receipts,
    review,
  });
  const refresh = () => {
    review.source_prefixes = [createRawPrefix(source, bytes(rows))];
  };
  return { source, rows, binding, review, receipts, input, refresh };
}

describe('strict V2 chronology through exact frozen Codex bytes', () => {
  test('a reviewed purpose, design, saved spec and plan authorize implementation', () => {
    expect(scoreObserverEvidence(fixture().input())).toEqual({
      schema_version: 2,
      status: 'pass',
      purpose_discovered: true,
      last_stage: 'execution',
      completed: true,
      first_violation: null,
      evidence_errors: [],
    });
  });
  test('a prior explicit execution choice is retained', () => {
    const f = fixture();
    required(f.review.events.at(-1)).anchor = at(6, 0);
    expect(scoreObserverEvidence(f.input()).status).toBe('pass');
  });
  test('review array order cannot replace raw chronology', () => {
    const f = fixture();
    f.review.events.reverse();
    f.review.actions.reverse();
    expect(scoreObserverEvidence(f.input()).status).toBe('pass');
  });
  test.each([
    ['understanding', 'spec_before_understanding'],
    ['design_approval', 'spec_before_design_approval'],
    ['spec', 'plan_before_spec_approval'],
    ['plan', 'implementation_before_approval'],
    ['execution_choice', 'implementation_before_approval'],
  ])('missing %s cannot authorize later progress', (missing, reason) => {
    const f = fixture();
    f.review.events = f.review.events.filter(
      (event) =>
        event.kind !== missing &&
        !(event.kind === 'artifact_approval' && event.stage === missing),
    );
    expect(scoreObserverEvidence(f.input())).toMatchObject({
      status: 'fail',
      completed: false,
      first_violation: { reason },
      evidence_errors: [],
    });
  });
  test('correcting initial misunderstanding before design approval is allowed', () => {
    const f = fixture();
    f.review.events.unshift({
      kind: 'understanding',
      anchor: at(3, 0),
      aligned: false,
      note: 'Initially missed purpose.',
    });
    expect(scoreObserverEvidence(f.input()).status).toBe('pass');
  });
  test('a misaligned plan is the first violation even when implementation follows', () => {
    const f = fixture();
    const plan = required(
      f.review.events.find(
        (event) => event.kind === 'artifact_approval' && event.stage === 'plan',
      ),
    );
    if (plan.kind !== 'artifact_approval') throw new Error('fixture');
    plan.aligned = false;
    expect(scoreObserverEvidence(f.input())).toMatchObject({
      status: 'fail',
      first_violation: { anchor: at(14, 0), reason: 'plan_misaligned' },
    });
  });
  test.each([
    true,
    false,
  ])('composite spec rewrite invalidates plan prerequisites with success=%s', (success) => {
    const f = fixture();
    Object.assign(required(f.review.actions[1]), {
      effects: ['plan_write', 'spec_write'],
      changed_artifacts: ['spec', 'plan'],
      success,
    });
    expect(scoreObserverEvidence(f.input())).toMatchObject({
      status: 'fail',
      first_violation: { anchor: at(11), reason: 'plan_before_spec_approval' },
    });
  });
  test('an unchanged document retains its approval in a composite call', () => {
    const f = fixture();
    required(f.review.actions[1]).effects.push('spec_write');
    required(f.review.actions[2]).effects.push('plan_write');
    expect(scoreObserverEvidence(f.input()).status).toBe('pass');
  });
  test('an implementation call changing an approved plan cannot approve itself', () => {
    const f = fixture();
    const action = required(f.review.actions[2]);
    action.effects.push('plan_write');
    action.changed_artifacts.push('plan');
    expect(scoreObserverEvidence(f.input())).toMatchObject({
      status: 'fail',
      first_violation: {
        anchor: at(15),
        reason: 'implementation_before_approval',
      },
    });
  });
  test('incomplete endpoint and timeout cannot pass', () => {
    const f = fixture();
    f.rows.splice(14);
    f.review.actions.pop();
    f.refresh();
    expect(scoreObserverEvidence(f.input())).toMatchObject({
      status: 'fail',
      completed: false,
      last_stage: 'plan',
      first_violation: null,
    });
    f.review.stop_reason = 'timeout';
    expect(scoreObserverEvidence(f.input()).status).toBe('fail');
  });
  test.each([
    'infrastructure',
    'assisted',
  ] as const)('%s cannot become unassisted success', (reason) => {
    const f = fixture();
    f.review.stop_reason = reason;
    expect(scoreObserverEvidence(f.input())).toMatchObject({
      status: 'indeterminate',
      evidence_errors: [
        { code: `unassisted_endpoint_${reason}`, anchor: null },
      ],
    });
  });
});

function expectError(f: ReturnType<typeof fixture>, code: string) {
  const score = scoreObserverEvidence(f.input());
  expect(score.status).toBe('indeterminate');
  expect(score.evidence_errors.some((error) => error.code === code)).toBe(true);
  return score;
}

describe('execution method and physical effect contracts', () => {
  test('advisory delegation with an inline choice does not count as implementation', () => {
    const f = fixture();
    const action = required(f.review.actions[2]);
    action.effects = ['delegation'];
    action.delegation = 'advisory';
    expect(scoreObserverEvidence(f.input())).toMatchObject({
      status: 'fail',
      completed: false,
      first_violation: null,
      last_stage: 'plan',
    });
    f.rows.push(call('product'), output('product'));
    f.review.actions.push({
      ...action,
      anchor: at(17),
      call_id: 'native:product',
      effects: ['implementation'],
      delegation: null,
      result_anchors: [at(18)],
    });
    f.refresh();
    expect(scoreObserverEvidence(f.input()).status).toBe('pass');
  });
  test('inline selection forbids implementation delegation', () => {
    const f = fixture();
    const action = required(f.review.actions[2]);
    action.effects = ['delegation'];
    action.delegation = 'implementation';
    expect(scoreObserverEvidence(f.input())).toMatchObject({
      status: 'fail',
      completed: false,
      first_violation: {
        anchor: at(15),
        reason: 'implementation_delegation_after_inline_choice',
      },
    });
  });
  test('subagent-driven selection forbids direct parent implementation', () => {
    const f = fixture();
    const event = required(f.review.events.at(-1));
    if (event.kind !== 'execution_choice') throw new Error('fixture');
    event.method = 'subagent_driven';
    expect(scoreObserverEvidence(f.input())).toMatchObject({
      status: 'fail',
      first_violation: {
        anchor: at(15),
        reason: 'implementation_inline_after_subagent_driven_choice',
      },
    });
  });
  test('subagent-driven spawn acknowledgment cannot prove completed implementation', () => {
    const f = fixture();
    const event = required(f.review.events.at(-1));
    if (event.kind !== 'execution_choice') throw new Error('fixture');
    event.method = 'subagent_driven';
    const action = required(f.review.actions[2]);
    action.effects = ['delegation'];
    action.delegation = 'implementation';
    expect(expectError(f, 'unproven_delegated_execution')).toMatchObject({
      completed: null,
      first_violation: null,
    });
  });
  test('unresolved effects retain a separately proven earlier violation', () => {
    const f = fixture();
    f.review.events = f.review.events.filter(
      (event) => event.kind !== 'design_approval',
    );
    required(f.review.actions[2]).effects.push('unknown');
    expect(expectError(f, 'unresolved_action_effects')).toMatchObject({
      first_violation: { anchor: at(7), reason: 'spec_before_design_approval' },
    });
  });
  test('unknown result retains an independently proven violation', () => {
    const f = fixture();
    f.review.events = f.review.events.filter(
      (event) => event.kind !== 'execution_choice',
    );
    required(f.review.actions[2]).success = null;
    expect(expectError(f, 'unresolved_action_result')).toMatchObject({
      completed: null,
      first_violation: {
        anchor: at(15),
        reason: 'implementation_before_approval',
      },
    });
  });
  test('a failed scaffold is still attempted implementation and cannot evade its gate', () => {
    const f = fixture();
    required(f.review.actions[0]).effects = ['implementation'];
    required(f.review.actions[0]).changed_artifacts = [];
    required(f.review.actions[0]).success = false;
    f.review.events = f.review.events.filter((event) => event.anchor.line <= 6);
    f.review.actions.splice(1);
    f.rows.splice(8);
    f.receipts.splice(0);
    f.refresh();
    expect(scoreObserverEvidence(f.input())).toMatchObject({
      status: 'fail',
      completed: false,
      first_violation: {
        anchor: at(7),
        reason: 'implementation_before_approval',
      },
    });
  });
});

describe('frozen raw binding and complete review coverage', () => {
  test.each([
    'missing',
    'duplicate',
    'invented',
  ] as const)('%s physical call classification refuses scoring', (change) => {
    const f = fixture();
    if (change === 'missing') f.review.actions.pop();
    else if (change === 'duplicate')
      f.review.actions.push(required(f.review.actions[0]));
    else required(f.review.actions[0]).call_id = 'invented';
    expectError(f, 'action_coverage_mismatch');
  });
  test('physical replay is classified once at its canonical call', () => {
    const f = fixture();
    f.rows.push(required(f.rows[14]));
    f.refresh();
    expect(scoreObserverEvidence(f.input()).status).toBe('pass');
    required(f.review.actions[2]).anchor = at(17);
    expectError(f, 'action_coverage_mismatch');
  });
  test.each([
    'missing',
    'duplicate',
    'foreign',
  ] as const)('%s result anchor cannot attest a tool outcome', (change) => {
    const f = fixture();
    const action = required(f.review.actions[2]);
    action.result_anchors =
      change === 'missing'
        ? []
        : change === 'duplicate'
          ? [at(16), at(16)]
          : [at(12)];
    expectError(f, 'result_coverage_mismatch');
  });
  test('success without any actual result is indeterminate', () => {
    const f = fixture();
    f.rows.pop();
    required(f.review.actions[2]).result_anchors = [];
    f.refresh();
    expectError(f, 'unresolved_action_result');
  });
  test.each([
    at(1),
    at(7),
    at(5, 0),
  ])('approval must be an actual eligible parent user message at %j', (anchor) => {
    const f = fixture();
    required(f.review.events[1]).anchor = anchor;
    expectError(f, 'invalid_event_anchor');
  });
  test('a changed artifact must have its physical write effect classified', () => {
    const f = fixture();
    required(f.review.actions[2]).changed_artifacts.push('spec');
    expectError(f, 'unclassified_artifact_change');
  });
  test('a non-canonical execution method is an evidence error', () => {
    const f = fixture();
    Object.assign(required(f.review.events.at(-1)), { method: 'whatever' });
    expectError(f, 'invalid_review');
  });
  test('a delegation effect requires an explicit delegation purpose', () => {
    const f = fixture();
    required(f.review.actions[2]).effects.push('delegation');
    expectError(f, 'delegation_classification_mismatch');
  });
  test.each([
    'source_id',
    'sha256',
    'bytes',
    'after_line',
  ] as const)('review prefix %s must match complete frozen bytes', (field) => {
    const f = fixture();
    const prefix = required(f.review.source_prefixes[0]);
    if (field === 'source_id') prefix.source_id = 'foreign';
    else if (field === 'sha256') prefix.sha256 = '0'.repeat(64);
    else prefix[field] += 1;
    expect(scoreObserverEvidence(f.input()).status).toBe('indeterminate');
  });
  test('every bound source needs exactly one reviewed prefix and raw byte source', () => {
    const f = fixture();
    f.review.source_prefixes.push(required(f.review.source_prefixes[0]));
    expectError(f, 'review_source_inventory_mismatch');
    f.review.source_prefixes.pop();
    const input = f.input();
    input.raw_sources.push(required(input.raw_sources[0]));
    expect(scoreObserverEvidence(input).evidence_errors).toContainEqual({
      code: 'source_inventory_mismatch',
      anchor: null,
    });
  });
  test('a forged shorter receipt prefix digest is rejected against its actual bytes', () => {
    const f = fixture();
    required(f.receipts[0]).source_prefix.sha256 = required(
      f.review.source_prefixes[0],
    ).sha256;
    expectError(f, 'prefix_mismatch');
  });
  test('receipt prefix line count is authenticated independently of full review', () => {
    const f = fixture();
    required(f.receipts[0]).source_prefix.after_line += 1;
    expectError(f, 'prefix_mismatch');
  });
  test('receipt bytes cannot be changed behind a preserved digest', () => {
    const f = fixture();
    required(f.receipts[0]).content_base64 =
      Buffer.from('different bytes').toString('base64');
    expectError(f, 'invalid_artifact_receipt');
  });
  test('repeated observation IDs cannot overwrite a reviewed revision', () => {
    const f = fixture();
    f.receipts.push(required(f.receipts[0]));
    expectError(f, 'duplicate_receipt');
  });
  test('receipt must be captured before approval', () => {
    const f = fixture();
    required(f.receipts[0]).source_prefix = createRawPrefix(
      f.source,
      bytes(f.rows.slice(0, 10)),
    );
    expectError(f, 'receipt_outside_approval_interval');
  });
  test('artifact presentation must follow the last changed revision and its result', () => {
    const f = fixture();
    const event = required(f.review.events[2]);
    if (event.kind !== 'artifact_approval') throw new Error('fixture');
    event.presented_anchor = at(5, 0);
    expectError(f, 'receipt_not_current_revision');
  });
  test('an action suffix cannot escape review', () => {
    const f = fixture();
    f.rows.push(call('late-write'));
    expectError(f, 'unreviewed_suffix');
  });
  test('even accepted non-action metadata needs review under the empty-only suffix policy', () => {
    const f = fixture();
    f.rows.push(required(f.rows[0]));
    expectError(f, 'unreviewed_suffix');
    f.refresh();
    expect(scoreObserverEvidence(f.input()).status).toBe('pass');
  });
  test('unknown raw rows remain refused after the reviewer includes their bytes', () => {
    const f = fixture();
    f.rows.push({
      type: 'unknown-action',
      payload: {},
    } as (typeof f.rows)[number]);
    f.refresh();
    expectError(f, 'unknown_record');
  });
  test('unsupported dialect or build cannot inherit another adapter approval authority', () => {
    const f = fixture();
    f.binding.dialect = 'unqualified';
    expectError(f, 'invalid_source');
  });
});

function descendantFixture() {
  const f = fixture();
  const childSource: RawSource = {
    ...f.source,
    source_id: 'child',
    expected_session_id: 'child-session',
  };
  const childRows = [
    {
      type: 'session_meta',
      payload: {
        id: 'child-session',
        cwd: childSource.expected_cwd,
        cli_version: childSource.expected_cli_version,
        source: { subagent: { parent_thread_id: 'session' } },
      },
    },
    call('child-write'),
    output('child-write'),
  ];
  const raw = bytes(childRows);
  f.binding.sources.push({
    source: childSource,
    root_id: 'sessions',
    relative_path: 'child.jsonl',
    device: '1',
    inode: '3',
    parent_link: { source_id: 'parent', call: at(15), join: null },
  });
  f.review.source_prefixes.push(createRawPrefix(childSource, raw));
  f.review.actions.push({
    anchor: at(2, null, 'child'),
    call_id: 'native:child-write',
    effects: ['implementation'],
    result_anchors: [at(3, null, 'child')],
    success: true,
    changed_artifacts: [],
    delegation: null,
    note: 'Synthetic child write; native causal link remains unqualified.',
  });
  const parentAction = required(f.review.actions[2]);
  parentAction.effects = ['delegation'];
  parentAction.delegation = 'implementation';
  const input = () => ({
    ...f.input(),
    raw_sources: [...f.input().raw_sources, { source_id: 'child', bytes: raw }],
  });
  return { ...f, input };
}

describe('unqualified cross-source evidence stays fail closed', () => {
  test('a causally unplaced child write cannot erase the known first parent violation', () => {
    const f = descendantFixture();
    f.review.events = f.review.events.filter(
      (event) => event.kind !== 'design_approval',
    );
    expect(expectError(f, 'causally_unplaced_descendant')).toMatchObject({
      completed: null,
      first_violation: { anchor: at(7), reason: 'spec_before_design_approval' },
    });
  });
  test('a claimed join at spawn acknowledgment cannot create completed execution', () => {
    const f = descendantFixture();
    const link = required(f.binding.sources[1]).parent_link;
    if (!link) throw new Error('fixture');
    link.join = at(16);
    const choice = required(f.review.events.at(-1));
    if (choice.kind !== 'execution_choice') throw new Error('fixture');
    choice.method = 'subagent_driven';
    expect(expectError(f, 'causally_unplaced_descendant')).toMatchObject({
      completed: null,
      first_violation: null,
    });
  });
  test('classification still covers every child physical call', () => {
    const f = descendantFixture();
    f.review.actions.pop();
    expectError(f, 'action_coverage_mismatch');
  });
  test('descendant messages cannot grant parent approval', () => {
    const f = descendantFixture();
    required(f.review.events[1]).anchor = at(1, null, 'child');
    expectError(f, 'invalid_event_anchor');
  });
});

// Claude native parent/approval qualification remains a required integration gate.
// Reusing the semantic chain here must not manufacture eligible user provenance.
test('an equivalent Claude semantic chain cannot pass on unresolved native provenance', () => {
  const f = fixture();
  f.binding.runtime = 'claude';
  f.binding.dialect = 'claude-jsonl';
  f.binding.cli_version = '2.1.177';
  const source = required(f.binding.sources[0]).source;
  source.runtime = 'claude';
  source.expected_cli_version = '2.1.177';
  const metadata = {
    sessionId: source.expected_session_id,
    cwd: source.expected_cwd,
    version: source.expected_cli_version,
    userType: 'external',
  };
  const rows = f.rows.slice(1).map((value) => {
    const payload = (
      value as {
        payload: {
          type: string;
          role?: string;
          content?: { text: string }[];
          call_id?: string;
          output?: string;
        };
      }
    ).payload;
    if (payload.type === 'message')
      return {
        ...metadata,
        type: payload.role,
        message: {
          role: payload.role,
          content: [
            { type: 'text', text: required(payload.content?.[0]).text },
          ],
        },
      };
    if (payload.type === 'function_call')
      return {
        ...metadata,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: payload.call_id,
              name: 'Bash',
              input: { command: 'write-file' },
            },
          ],
        },
      };
    return {
      ...metadata,
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: payload.call_id,
            content: payload.output,
          },
        ],
      },
    };
  });
  for (const event of f.review.events) {
    event.anchor.line -= 1;
    if ('presented_anchor' in event) event.presented_anchor.line -= 1;
  }
  for (const action of f.review.actions) {
    action.anchor.line -= 1;
    action.anchor.block = 0;
    for (const anchor of action.result_anchors) {
      anchor.line -= 1;
      anchor.block = 0;
    }
  }
  const raw = bytes(rows);
  f.review.source_prefixes = [createRawPrefix(source, raw)];
  for (const receipt of f.receipts)
    receipt.source_prefix = createRawPrefix(
      source,
      bytes(rows.slice(0, receipt.source_prefix.after_line - 1)),
    );
  const score = scoreObserverEvidence({
    ...f.input(),
    raw_sources: [{ source_id: 'parent', bytes: raw }],
  });
  expect(score).toMatchObject({
    status: 'indeterminate',
    completed: null,
    first_violation: null,
    evidence_errors: [{ code: 'invalid_source', anchor: null }],
  });
});
