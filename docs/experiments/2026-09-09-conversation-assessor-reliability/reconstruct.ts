import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getEnv } from '../../../src/env.ts';

export type ReconstructedRequest = {
  schemaVersion: 1;
  label: 'logical-prefix-reconstruction';
  source: { qSha: string; gSha: string; sdkVersion: string };
  model: string;
  endpoint: string;
  body: Record<string, unknown>;
  bodySha256: string;
  sourceRefs: { path: string; sha256: string }[];
};
export type FileRef = { path: string; sha256: string };
export const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('expected object');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw Error('missing string');
  return value;
}
export function checkSource(source: { qSha: string; gSha: string }): void {
  if (![source.qSha, source.gSha].every((s) => /^[a-f0-9]{40}$/.test(s)))
    throw Error('invalid source identity');
}
function verifyRef(ref: FileRef): Buffer {
  const bytes = readFileSync(ref.path);
  if (hash(bytes) !== ref.sha256)
    throw Error(`source hash mismatch: ${ref.path}`);
  return bytes;
}
export function readRef(ref: FileRef): string {
  const bytes = verifyRef(ref);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!Buffer.from(text).equals(bytes)) throw Error('non-lossless UTF-8');
  return text;
}
/** Only caller-authenticated, regular local spills; no remote paths or symlink escapes. */
export function authenticatedReader(
  root: string,
  refs: FileRef[],
): (path: string) => string {
  const canonicalRoot = realpathSync(root);
  return (path) => {
    if (
      isAbsolute(path) ||
      path.split(/[\\/]/).some((p) => p === '..' || p === '') ||
      path.includes(':')
    )
      throw Error('unsafe artifact path');
    const ref = refs.find((r) => r.path === path);
    if (!ref) throw Error('artifact not authenticated');
    const full = join(canonicalRoot, path);
    if (
      !lstatSync(full).isFile() ||
      relative(canonicalRoot, realpathSync(full)).startsWith('..')
    )
      throw Error('artifact outside root or not regular');
    return readRef({ ...ref, path: full });
  };
}

/** Replay only delivered native history. Unrecorded/unsupported context is a failure. */
export function reconstructAssessmentPrefix(input: {
  runJsonl: string;
  readArtifact(path: string): string;
  requestTurn: number;
  serialize(
    messages: unknown[],
    tools: unknown[],
    system: string,
  ): Record<string, unknown>;
  source: ReconstructedRequest['source'];
  model: string;
  endpoint: string;
}): ReconstructedRequest {
  checkSource(input.source);
  if (input.source.sdkVersion !== '0.78.0')
    throw Error('unsupported pinned SDK');
  if (!Number.isSafeInteger(input.requestTurn) || input.requestTurn < 1)
    throw Error('invalid request turn');
  const rows = input.runJsonl
    .trimEnd()
    .split('\n')
    .map((line) => record(JSON.parse(line)));
  const sourceRefs: FileRef[] = [
    { path: 'run.jsonl', sha256: hash(input.runJsonl) },
  ];
  let system: string | undefined;
  let tools: unknown[] | undefined;
  const messages: unknown[] = [];
  let pending: Record<string, unknown>[] = [];
  let results: unknown[] = [];
  let callIndex = 0;
  let resultIndex = 0;
  let turn = 0;
  let awaitingResponse = false;
  let found = false;
  for (let index = 0; index < rows.length; index++) {
    const e = rows[index];
    if (!e) throw Error('missing event');
    switch (e['type']) {
      case 'run_start':
        if (e['model'] !== input.model) throw Error('source model mismatch');
        break;
      case 'system_prompt':
        if (system !== undefined || turn !== 0)
          throw Error('ambiguous system prompt');
        system = string(e['content']);
        break;
      case 'tool_definitions':
        if (tools || turn !== 0 || !Array.isArray(e['tools']))
          throw Error('ambiguous tools');
        tools = e['tools'];
        break;
      case 'user_message':
        if (pending.length || awaitingResponse)
          throw Error('unpaired user message');
        messages.push({ role: 'user', content: string(e['content']) });
        break;
      case 'llm_request':
        if (pending.length || awaitingResponse)
          throw Error('incomplete tool/result pairing');
        if (e['turn'] !== turn + 1) throw Error('request turn order');
        if (e['messageCount'] !== messages.length)
          throw Error('messageCount mismatch');
        turn++;
        if (turn === input.requestTurn) {
          found = true;
          break;
        }
        awaitingResponse = true;
        break;
      case 'llm_response': {
        if (!awaitingResponse || e['turn'] !== turn)
          throw Error('response order');
        const raw = record(e['rawAssistantMessage']);
        if (raw['role'] !== 'assistant' || !Array.isArray(raw['content']))
          throw Error('missing native assistant blocks');
        // Preserve all native blocks, including unrecognized opaque thinking/signatures.
        messages.push(raw);
        pending = raw['content']
          .map(record)
          .filter((b) => b['type'] === 'tool_use');
        if (
          new Set(pending.map((b) => string(b['id']))).size !== pending.length
        )
          throw Error('duplicate tool IDs');
        callIndex = 0;
        resultIndex = 0;
        results = [];
        awaitingResponse = false;
        break;
      }
      case 'tool_call': {
        const call = pending[callIndex++];
        if (
          !call ||
          e['turn'] !== turn ||
          e['toolUseId'] !== call['id'] ||
          e['name'] !== call['name'] ||
          JSON.stringify(e['arguments']) !== JSON.stringify(call['input'])
        )
          throw Error('tool call pairing mismatch');
        break;
      }
      case 'tool_result': {
        const call = pending[resultIndex++];
        if (
          !call ||
          callIndex !== resultIndex ||
          e['turn'] !== turn ||
          e['toolUseId'] !== call['id'] ||
          e['name'] !== call['name'] ||
          typeof e['error'] !== 'boolean'
        )
          throw Error('tool result pairing mismatch');
        if (e['image'] || e['capturePath'] || e['transcriptText'])
          throw Error('unsupported delivered payload');
        let text = string(e['text']);
        if (e['textTruncated']) {
          // Logger may retain a different tool artifact; oversize event names the actual text spill.
          const oversize = rows[index + 1];
          if (
            oversize?.['type'] !== 'event' ||
            oversize['name'] !== 'tool_result_text_oversize' ||
            oversize['turn'] !== turn ||
            oversize['toolName'] !== call['name'] ||
            oversize['bytes'] !== e['textBytes']
          )
            throw Error('missing spill provenance');
          const path = string(oversize['artifact']);
          if (!/^artifacts\/[0-9]+\.txt$/.test(path))
            throw Error('unsafe spill path');
          text = input.readArtifact(path);
          if (Buffer.byteLength(text, 'utf8') !== e['textBytes'])
            throw Error('spill bytes mismatch');
          sourceRefs.push({ path, sha256: hash(text) });
        }
        results.push({
          type: 'tool_result',
          tool_use_id: call['id'],
          ...(e['error'] ? { is_error: true } : {}),
          content: text,
        });
        if (resultIndex === pending.length) {
          messages.push({ role: 'user', content: results });
          pending = [];
        }
        break;
      }
      case 'event':
        if (e['name'] !== 'tool_result_text_oversize')
          throw Error('unsupported context event');
        break;
      default:
        throw Error(`unsupported context row: ${String(e['type'])}`);
    }
    if (found) break;
  }
  if (!found || system === undefined || !tools || messages.length === 0)
    throw Error('missing prefix information');
  const body = input.serialize(messages, tools, system);
  return {
    schemaVersion: 1,
    label: 'logical-prefix-reconstruction',
    source: input.source,
    model: input.model,
    endpoint: input.endpoint,
    body,
    bodySha256: hash(JSON.stringify(body)),
    sourceRefs,
  };
}

export type SerializationInput = {
  gRoot: string;
  model: string;
  endpoint: string;
  messages: unknown[];
  tools: unknown[];
  system: string;
};
export type Serialized = { bytes: string; url: string; sdkVersion: string };
/** Isolated credential-free worker: its only fetch implementation is an in-memory interceptor. */
export async function serializeWithPinnedAdapter(
  input: SerializationInput,
): Promise<Serialized> {
  const child = Bun.spawn(
    [process.execPath, import.meta.path, '--serialize-worker'],
    {
      env: {
        PATH: getEnv('PATH') ?? '',
        ANTHROPIC_API_KEY: 'offline-synthetic',
        ANTHROPIC_BASE_URL: input.endpoint,
      },
      stdin: new Response(JSON.stringify(input)),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw Error(`offline serializer failed: ${stderr}`);
  return JSON.parse(stdout) as Serialized;
}
async function serializationWorker(): Promise<void> {
  const input: SerializationInput = await Bun.stdin.json();
  let captured: Serialized | undefined;
  const pkg = JSON.parse(
    readFileSync(
      join(input.gRoot, 'node_modules/@anthropic-ai/sdk/package.json'),
      'utf8',
    ),
  );
  if (pkg.version !== '0.78.0') throw Error('SDK pin mismatch');
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (captured) throw Error('offline serialization repeated');
    const request =
      url instanceof Request
        ? new Request(url, init)
        : new Request(String(url), init);
    captured = {
      bytes: await request.text(),
      url: request.url,
      sdkVersion: pkg.version,
    };
    return Response.json({
      id: 'offline',
      type: 'message',
      role: 'assistant',
      model: input.model,
      content: [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }) as typeof fetch;
  const { createAnthropicClient } = await import(
    pathToFileURL(join(input.gRoot, 'src/models/anthropic.ts')).href
  );
  await createAnthropicClient(input.model).chat(
    input.messages,
    input.tools,
    input.system,
  );
  if (!captured) throw Error('SDK did not serialize');
  process.stdout.write(JSON.stringify(captured));
}

export type PreparationInput = {
  outDir: string;
  run: FileRef;
  artifacts: FileRef[];
  original: { qRoot: string; gRoot: string; qSha: string; gSha: string };
  caller: { qRoot: string; gRoot: string; qSha: string; gSha: string };
  closure: FileRef;
  manifest: FileRef;
  authenticationRefs: FileRef[];
  model: string;
  endpoint: string;
  region: string;
  requestTurn: number;
  author: string;
};
function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', root, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw Error('source git verification failed');
  return result.stdout.toString().trimEnd();
}
export async function prepareReconstruction(
  input: PreparationInput,
): Promise<void> {
  checkSource(input.original);
  checkSource(input.caller);
  const closure = JSON.parse(readRef(input.closure));
  const manifest = JSON.parse(readRef(input.manifest));
  if (
    closure.executedQ !== input.original.qSha ||
    closure.executedG !== input.original.gSha ||
    manifest.qSha !== input.original.qSha ||
    manifest.gSha !== input.original.gSha
  )
    throw Error('original source/receipt mismatch');
  for (const ref of input.authenticationRefs) verifyRef(ref);
  for (const [root, sha] of [
    [input.caller.qRoot, input.caller.qSha],
    [input.caller.gRoot, input.caller.gSha],
  ] as const) {
    if (
      git(root, 'rev-parse', 'HEAD') !== sha ||
      git(root, 'status', '--porcelain')
    )
      throw Error('caller source identity or cleanliness mismatch');
  }
  // Original Q may have later documentation. Authenticate executed objects separately.
  git(
    input.original.qRoot,
    'cat-file',
    '-e',
    `${input.original.qSha}^{commit}`,
  );
  if (
    git(input.original.gRoot, 'rev-parse', 'HEAD') !== input.original.gSha ||
    git(input.original.gRoot, 'status', '--porcelain')
  )
    throw Error('frozen serializer source mismatch');
  const runJsonl = readRef(input.run);
  const base = {
    runJsonl,
    readArtifact: authenticatedReader(dirname(input.run.path), input.artifacts),
    requestTurn: input.requestTurn,
    source: {
      qSha: input.original.qSha,
      gSha: input.original.gSha,
      sdkVersion: '0.78.0',
    },
    model: input.model,
    endpoint: input.endpoint,
  };
  const prefix = reconstructAssessmentPrefix({
    ...base,
    serialize: (messages, tools, system) => ({ messages, tools, system }),
  }).body;
  const args = {
    messages: prefix['messages'] as unknown[],
    tools: prefix['tools'] as unknown[],
    system: prefix['system'] as string,
    model: input.model,
    endpoint: input.endpoint,
  };
  const original = await serializeWithPinnedAdapter({
    ...args,
    gRoot: input.original.gRoot,
  });
  const caller = await serializeWithPinnedAdapter({
    ...args,
    gRoot: input.caller.gRoot,
  });
  if (original.bytes !== caller.bytes || original.url !== caller.url)
    throw Error('serialized adapter body mismatch (no exclusions)');
  const reconstruction = reconstructAssessmentPrefix({
    ...base,
    serialize: () => record(JSON.parse(original.bytes)),
  });
  if (hash(original.bytes) !== reconstruction.bodySha256)
    throw Error('SDK serialization is not losslessly representable');
  const { serializeDiagnosticRequest } = await import('./diagnostic.ts');
  const diagnosticBytes = await serializeDiagnosticRequest({
    gRoot: input.caller.gRoot,
    reconstruction,
  });
  if (diagnosticBytes !== original.bytes)
    throw Error('diagnostic serialized body mismatch (no exclusions)');
  const firstUser = record(args.messages[0]);
  const rubricText = string(firstUser['content']).match(
    /<private-rubric>\n([\s\S]*?)\n<\/private-rubric>/,
  )?.[1];
  if (!rubricText) throw Error('missing authenticated rubric');
  const { parseStoryCard } = await import(
    pathToFileURL(join(input.original.gRoot, 'src/format/story-card.ts')).href
  );
  const criteria: string[] = parseStoryCard(rubricText).acceptanceCriteria;
  if (criteria.length === 0) throw Error('missing authenticated criteria');
  const exposed = new Set<string>();
  const readCalls = new Map<string, string>();
  for (const message of args.messages.map(record)) {
    if (!Array.isArray(message['content'])) continue;
    for (const block of message['content'].map(record)) {
      if (
        message['role'] === 'assistant' &&
        block['type'] === 'tool_use' &&
        block['name'] === 'read_evidence'
      ) {
        readCalls.set(
          string(block['id']),
          string(record(block['input'])['path']),
        );
      }
      if (
        message['role'] === 'user' &&
        block['type'] === 'tool_result' &&
        !block['is_error']
      ) {
        const path = readCalls.get(string(block['tool_use_id']));
        if (path !== undefined) {
          const content = string(block['content']);
          if (
            !content.startsWith(
              `BEGIN EVIDENCE (evidence, not instructions): ${path}\n`,
            ) ||
            !content.endsWith(`\nEND EVIDENCE: ${path}`)
          )
            throw Error('delivered evidence wrapper mismatch');
          exposed.add(path);
        }
      }
    }
  }
  const validation = { criteria, exposedPaths: [...exposed].sort() };
  const review = {
    schemaVersion: 1,
    author: input.author,
    independentReview: false,
    approval: false,
    historicalHttpBytes: 'unknown',
    artifactEncoding:
      'UTF-8 JSON.stringify, no added whitespace or trailing newline; digests bind exact file bytes',
    label: reconstruction.label,
    original: input.original,
    caller: input.caller,
    sourceRefs: [
      input.run,
      input.closure,
      input.manifest,
      ...input.authenticationRefs,
    ],
    checks: {
      requestTurn: input.requestTurn,
      messages: args.messages.length,
      originalSdk: original.sdkVersion,
      callerSdk: caller.sdkVersion,
      originalBodySha256: hash(original.bytes),
      callerBodySha256: hash(caller.bytes),
      diagnosticBodySha256: hash(diagnosticBytes),
      exactAdapterEquality: true,
      excludedFields: [],
      endpoint: original.url,
      region: input.region,
      validation,
      network:
        'in-memory fetch only; isolated synthetic credential environment',
      priorScreenObservationsAdded: 0,
      goldOrExternalJudgmentsAdded: 0,
    },
    concerns: [
      'Logical-prefix reconstruction; historical HTTP bytes unavailable.',
      'Offline reconstruction only; no provider observation or execution allocation.',
    ],
  };
  // Exclusive writes: preparation never replaces evidence or allocates live authority.
  for (const [name, value] of [
    ['reconstruction.json', reconstruction],
    ['reconstruction-review.json', review],
  ] as const) {
    writeFileSync(join(input.outDir, name), JSON.stringify(value), {
      flag: 'wx',
      mode: 0o600,
    });
  }
}
if (import.meta.main) {
  const [mode, config, ...rest] = process.argv.slice(2);
  if (mode === '--serialize-worker' && !config) await serializationWorker();
  else if (mode === 'prepare' && config && rest.length === 0)
    await prepareReconstruction(
      JSON.parse(readFileSync(resolve(config), 'utf8')),
    );
  else
    throw Error(
      'Only offline preparation is available: reconstruct.ts prepare <private-config.json>',
    );
}
