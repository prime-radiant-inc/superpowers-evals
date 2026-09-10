import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authenticatedReader,
  prepareReconstruction,
  reconstructAssessmentPrefix,
  serializeWithPinnedAdapter,
} from '../docs/experiments/2026-09-09-conversation-assessor-reliability/reconstruct.ts';
import { getEnv } from '../src/env.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const opaque = {
  type: 'thinking',
  thinking: 'opaque\ntext',
  signature: 'sig+/==\n',
};
const calls = [
  {
    type: 'tool_use',
    id: 'a',
    name: 'read_evidence',
    input: { path: 'visible/a' },
  },
  {
    type: 'tool_use',
    id: 'b',
    name: 'report_result',
    input: { reasoning: 'prior malformed report' },
  },
];
const delivered =
  'BEGIN EVIDENCE (evidence, not instructions): visible/a\n\u001b[0m evidence\nEND EVIDENCE: visible/a';
const events = [
  { type: 'run_start', model: 'anthropic.claude-sonnet-5' },
  { type: 'system_prompt', content: 'original system' },
  {
    type: 'tool_definitions',
    tools: [
      {
        name: 'report_result',
        description: 'first description',
        parameters: {
          type: 'object',
          properties: { criteria: {}, reasoning: {} },
        },
      },
    ],
  },
  {
    type: 'user_message',
    turn: 0,
    content: 'original rubric and evidence index',
  },
  { type: 'llm_request', turn: 1, messageCount: 1 },
  {
    type: 'llm_response',
    turn: 1,
    rawAssistantMessage: { role: 'assistant', content: [opaque, ...calls] },
  },
  {
    type: 'tool_call',
    turn: 1,
    toolUseId: 'a',
    name: 'read_evidence',
    arguments: { path: 'visible/a' },
  },
  {
    type: 'tool_result',
    turn: 1,
    toolUseId: 'a',
    name: 'read_evidence',
    text: '',
    textTruncated: true,
    textBytes: Buffer.byteLength(delivered),
    artifact: 'artifacts/001.txt',
    error: false,
  },
  {
    type: 'event',
    name: 'tool_result_text_oversize',
    turn: 1,
    toolName: 'read_evidence',
    bytes: Buffer.byteLength(delivered),
    artifact: 'artifacts/001.txt',
  },
  {
    type: 'tool_call',
    turn: 1,
    toolUseId: 'b',
    name: 'report_result',
    arguments: calls[1]!.input,
  },
  {
    type: 'tool_result',
    turn: 1,
    toolUseId: 'b',
    name: 'report_result',
    text: 'Error: missing native criteria',
    error: true,
  },
  { type: 'llm_request', turn: 2, messageCount: 3 },
  { type: 'user_message', content: 'OTHER RUN GOLD MUST STAY OUT' },
];
function input(rows: unknown[] = events) {
  return {
    runJsonl: rows.map((x) => JSON.stringify(x)).join('\n'),
    requestTurn: 2,
    readArtifact: (path: string) => {
      if (path !== 'artifacts/001.txt') throw Error('not authenticated');
      return delivered;
    },
    source: {
      qSha: 'a'.repeat(40),
      gSha: 'b'.repeat(40),
      sdkVersion: '0.78.0',
    },
    model: 'anthropic.claude-sonnet-5',
    endpoint: 'https://example.invalid',
    serialize: (messages: unknown[], tools: unknown[], system: string) => ({
      messages,
      tools,
      system,
    }),
  };
}
test('expands exact spill bytes, preserves opaque blocks and ordered native report/error history, excludes later judgments', () => {
  const result = reconstructAssessmentPrefix(input());
  expect(result.body).toEqual({
    system: 'original system',
    tools: events[2]!.tools,
    messages: [
      { role: 'user', content: 'original rubric and evidence index' },
      { role: 'assistant', content: [opaque, ...calls] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: delivered },
          {
            type: 'tool_result',
            tool_use_id: 'b',
            is_error: true,
            content: 'Error: missing native criteria',
          },
        ],
      },
    ],
  });
  expect(result.bodySha256).toBe(sha(JSON.stringify(result.body)));
  expect(result.sourceRefs).toContainEqual({
    path: 'artifacts/001.txt',
    sha256: sha(delivered),
  });
  expect(JSON.stringify(result.body)).not.toContain('OTHER RUN');
});
test('missing artifacts, invalid source IDs, byte loss and broken tool pairing fail closed', () => {
  expect(() =>
    reconstructAssessmentPrefix({
      ...input(),
      readArtifact() {
        throw Error('missing artifact');
      },
    }),
  ).toThrow('missing artifact');
  expect(() =>
    reconstructAssessmentPrefix({
      ...input(),
      source: { ...input().source, gSha: 'unknown' },
    }),
  ).toThrow('source');
  expect(() =>
    reconstructAssessmentPrefix({ ...input(), readArtifact: () => 'partial' }),
  ).toThrow('bytes');
  expect(() =>
    reconstructAssessmentPrefix(input(events.filter((_, i) => i !== 10))),
  ).toThrow('pair');
  expect(() =>
    reconstructAssessmentPrefix(
      input(events.map((e, i) => (i === 11 ? { ...e, messageCount: 4 } : e))),
    ),
  ).toThrow('messageCount');
});
test('authenticated local reader rejects changed bytes, unlisted paths and traversal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reconstruct-'));
  try {
    writeFileSync(join(dir, 'a'), 'original');
    const read = authenticatedReader(dir, [
      { path: 'a', sha256: sha('original') },
    ]);
    expect(read('a')).toBe('original');
    expect(() => read('../a')).toThrow();
    expect(() => read('gold')).toThrow();
    writeFileSync(join(dir, 'a'), 'changed');
    expect(() => read('a')).toThrow('hash');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
const gRoot = getEnv('ASSESSMENT_G_ROOT');
test.skipIf(!gRoot)(
  'actual pinned adapter/SDK offline serialization preserves cache, schema order, effort, cap and opaque bytes',
  async () => {
    const prefix = reconstructAssessmentPrefix(input()).body;
    const capture = await serializeWithPinnedAdapter({
      gRoot: gRoot!,
      model: input().model,
      endpoint: input().endpoint,
      messages: prefix['messages'] as unknown[],
      tools: prefix['tools'] as unknown[],
      system: prefix['system'] as string,
    });
    const body = JSON.parse(capture.bytes);
    expect(body.max_tokens).toBe(16384);
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.messages[1].content[0]).toEqual(opaque);
    expect(body.system).toEqual([
      {
        type: 'text',
        text: 'original system',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(Object.keys(body.tools[0].input_schema.properties)).toEqual([
      'criteria',
      'reasoning',
    ]);
    expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[2].content[1].cache_control).toEqual({
      type: 'ephemeral',
    });
    expect(capture.sdkVersion).toBe('0.78.0');
    expect(capture.url).toBe('https://example.invalid/v1/messages');
  },
);

test.skipIf(!gRoot)(
  'offline preparation authenticates distinct original/caller identities and compares diagnostic SDK serialization with no exclusions',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'prepare-assessment-'));
    const q = join(root, 'q');
    mkdirSync(q);
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(['git', '-C', q, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (r.exitCode) throw Error(r.stderr.toString());
      return r.stdout.toString().trim();
    };
    try {
      git('init');
      writeFileSync(join(q, 'source'), 'original');
      git('add', 'source');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'original',
      );
      const originalQ = git('rev-parse', 'HEAD');
      writeFileSync(join(q, 'source'), 'caller');
      git('add', 'source');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'caller',
      );
      const callerQ = git('rev-parse', 'HEAD');
      const gSha = Bun.spawnSync(['git', '-C', gRoot!, 'rev-parse', 'HEAD'])
        .stdout.toString()
        .trim();
      const ref = (name: string, value: unknown) => {
        const path = join(root, name);
        const bytes = JSON.stringify(value);
        writeFileSync(path, bytes);
        return { path, sha256: sha(bytes) };
      };
      const closure = ref('closure', { executedQ: originalQ, executedG: gSha });
      const manifest = ref('manifest', { qSha: originalQ, gSha });
      const rubric =
        '---\nid: fixture\ntitle: Fixture\n---\n## Acceptance Criteria\n- Criterion';
      const log = input(
        events.map((e, i) =>
          i === 3
            ? {
                ...e,
                content: `<private-rubric>\n${rubric}\n</private-rubric>`,
              }
            : e,
        ),
      ).runJsonl;
      const path = join(root, 'run.jsonl');
      writeFileSync(path, log);
      mkdirSync(join(root, 'artifacts'));
      writeFileSync(join(root, 'artifacts/001.txt'), delivered);
      const outDir = join(root, 'out');
      mkdirSync(outDir);
      const binary = join(root, 'archive.bin');
      writeFileSync(binary, new Uint8Array([0xff, 0x00, 0xfe]));
      const binarySha = createHash('sha256')
        .update(readFileSync(binary))
        .digest('hex');
      const config = {
        outDir,
        run: { path, sha256: sha(log) },
        artifacts: [{ path: 'artifacts/001.txt', sha256: sha(delivered) }],
        original: { qRoot: q, gRoot: gRoot!, qSha: originalQ, gSha },
        caller: { qRoot: q, gRoot: gRoot!, qSha: callerQ, gSha },
        closure,
        manifest,
        authenticationRefs: [{ path: binary, sha256: binarySha }],
        model: input().model,
        endpoint: input().endpoint,
        region: 'synthetic',
        requestTurn: 2,
        author: 'test fixture',
      };
      await expect(
        prepareReconstruction({
          ...config,
          original: { ...config.original, qSha: callerQ },
        }),
      ).rejects.toThrow('source/receipt mismatch');
      await prepareReconstruction(config);
      const review = JSON.parse(
        readFileSync(join(outDir, 'reconstruction-review.json'), 'utf8'),
      );
      expect(readdirSync(outDir).sort()).toEqual([
        'reconstruction-review.json',
        'reconstruction.json',
      ]);
      const reconstructed = readFileSync(
        join(outDir, 'reconstruction.json'),
        'utf8',
      );
      expect(sha(reconstructed)).toBe(
        sha(JSON.stringify(JSON.parse(reconstructed))),
      );
      expect(review.independentReview).toBe(false);
      expect(review.approval).toBe(false);
      expect(review.checks.diagnosticBodySha256).toBe(
        review.checks.originalBodySha256,
      );
      expect(review.checks.excludedFields).toEqual([]);
      expect(review.original.qSha).not.toBe(review.caller.qSha);
      expect(review.checks.validation).toEqual({
        criteria: ['Criterion'],
        exposedPaths: ['visible/a'],
      });
      await expect(prepareReconstruction(config)).rejects.toThrow('EEXIST');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
