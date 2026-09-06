import { isDeepStrictEqual } from 'node:util';

export type NativeObserverBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown };

export interface NativeObserverStep {
  protocol: 'messages' | 'responses';
  // Predicates are supplied by the inspected capture script, receive a copy,
  // and must explicitly return true. They can bind observed dynamic IDs across
  // requests; they cannot mutate fixed blocks or bypass tool validation.
  // A separately validated response factory may use the bound state.
  request:
    | Record<string, unknown>
    | ((request: Readonly<Record<string, unknown>>) => boolean);
  // Factories run only after request acceptance. Their output is cloned and
  // subjected to the same catalog, argument and byte limits as fixed blocks.
  blocks:
    | NativeObserverBlock[]
    | ((request: Readonly<Record<string, unknown>>) => NativeObserverBlock[]);
}
type ResolvedStep = Omit<NativeObserverStep, 'blocks'> & {
  blocks: NativeObserverBlock[];
};

interface Options {
  port?: number;
  steps: NativeObserverStep[];
  maxRequests?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}
export interface NativeObserverRecord {
  sequence: number;
  method: string;
  path: string;
  fakeAuth: boolean;
  request?: unknown;
  decision: string;
  chunks: string[];
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requireCondition(
  condition: unknown,
  reason: string,
): asserts condition {
  if (!condition) throw new Error(reason);
}
function bound(value: number, maximum: number, label: string) {
  requireCondition(
    Number.isInteger(value) && value > 0 && value <= maximum,
    `invalid ${label}`,
  );
  return value;
}

// Intentionally a small, default-deny JSON Schema subset. Supporting a native
// tool's additional keywords requires inspecting that tool, not ignoring them.
function validator(schema: unknown): (value: unknown) => boolean {
  requireCondition(object(schema), 'tool schema must be an object');
  requireCondition(
    Object.keys(schema).every((key) =>
      [
        'type',
        'properties',
        'required',
        'additionalProperties',
        'items',
        'enum',
        'description',
        'title',
      ].includes(key),
    ),
    'unsupported tool schema keyword',
  );
  const type = schema['type'];
  requireCondition(
    [
      'object',
      'array',
      'string',
      'number',
      'integer',
      'boolean',
      'null',
    ].includes(String(type)),
    'unsupported schema type',
  );
  const enumeration = schema['enum'];
  requireCondition(
    enumeration === undefined ||
      (Array.isArray(enumeration) && enumeration.length > 0),
    'invalid enum',
  );
  const fields = schema['properties'];
  const required = schema['required'];
  const additional = schema['additionalProperties'];
  requireCondition(
    type === 'object' ||
      (fields === undefined &&
        required === undefined &&
        additional === undefined),
    'object keywords on non-object',
  );
  requireCondition(
    type === 'array' || schema['items'] === undefined,
    'items on non-array',
  );
  requireCondition(
    fields === undefined || object(fields),
    'invalid properties',
  );
  requireCondition(
    required === undefined ||
      (Array.isArray(required) &&
        required.every((key) => typeof key === 'string')),
    'invalid required',
  );
  requireCondition(
    additional === undefined || typeof additional === 'boolean',
    'unsupported additionalProperties',
  );
  const properties = new Map(
    Object.entries(fields ?? {}).map(([name, child]) => [
      name,
      validator(child),
    ]),
  );
  const item = type === 'array' ? validator(schema['items']) : undefined;
  return (value) => {
    if (
      enumeration &&
      !enumeration.some((entry) => isDeepStrictEqual(value, entry))
    )
      return false;
    if (type === 'object') {
      return (
        object(value) &&
        (required ?? []).every((key: string) => Object.hasOwn(value, key)) &&
        Object.entries(value).every(([key, child]) =>
          properties.has(key)
            ? properties.get(key)!(child)
            : additional !== false,
        )
      );
    }
    if (type === 'array') return Array.isArray(value) && value.every(item!);
    if (type === 'null') return value === null;
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'number')
      return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
  };
}

function validateStep(step: ResolvedStep, request: ObjectValue) {
  requireCondition(
    step.protocol === 'messages' || step.protocol === 'responses',
    'unsupported protocol',
  );
  requireCondition(
    request['stream'] === true && typeof request['model'] === 'string',
    'expected streaming model request',
  );
  requireCondition(
    Array.isArray(request[step.protocol === 'messages' ? 'messages' : 'input']),
    'expected conversation array',
  );
  const tools = request['tools'] ?? [];
  requireCondition(Array.isArray(tools), 'expected tool catalog');
  const catalog = new Map<string, (value: unknown) => boolean>();
  for (const tool of tools) {
    requireCondition(
      object(tool) && typeof tool['name'] === 'string',
      'unsupported tool catalog entry',
    );
    requireCondition(
      step.protocol !== 'responses' || tool['type'] === 'function',
      'only JSON function tools are supported',
    );
    requireCondition(!catalog.has(tool['name']), 'duplicate tool name');
    catalog.set(
      tool['name'],
      validator(
        tool[step.protocol === 'messages' ? 'input_schema' : 'parameters'],
      ),
    );
  }
  requireCondition(
    Array.isArray(step.blocks) && step.blocks.length > 0,
    'expected nonempty response blocks',
  );
  const ids = new Set<string>();
  for (const block of step.blocks) {
    if (block.type === 'text') {
      requireCondition(
        typeof block.text === 'string' && block.text.length > 0,
        'empty response text',
      );
    } else {
      requireCondition(
        block.type === 'tool' && block.id.length > 0 && !ids.has(block.id),
        'invalid or duplicate call id',
      );
      ids.add(block.id);
      requireCondition(
        catalog.get(block.name)?.(block.input),
        'unadvertised tool or invalid tool arguments',
      );
    }
  }
}

function parts(value: string): string[] {
  const characters = Array.from(value);
  const middle = Math.max(1, Math.floor(characters.length / 2));
  return [
    characters.slice(0, middle).join(''),
    characters.slice(middle).join(''),
  ].filter(Boolean);
}

// Wire event shapes are from the official SDKs bundled in the selected Gauntlet
// checkout. These are protocol fixtures, not native CLI transcript evidence.
function eventsFor(
  step: ResolvedStep,
  sequence: number,
  request: ObjectValue,
): ObjectValue[] {
  const model = request['model'];
  const events: ObjectValue[] = [];
  const add = (type: string, fields: ObjectValue = {}) =>
    events.push({ type, ...fields });
  if (step.protocol === 'messages') {
    add('message_start', {
      message: {
        id: `msg_fixture_${sequence}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        container: null,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    step.blocks.forEach((block, index) => {
      const text = block.type === 'text';
      add('content_block_start', {
        index,
        content_block: text
          ? { type: 'text', text: '' }
          : { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      for (const part of parts(
        text ? block.text : JSON.stringify(block.input),
      )) {
        add('content_block_delta', {
          index,
          delta: text
            ? { type: 'text_delta', text: part }
            : { type: 'input_json_delta', partial_json: part },
        });
      }
      add('content_block_stop', { index });
    });
    add('message_delta', {
      delta: {
        stop_reason: step.blocks.some((block) => block.type === 'tool')
          ? 'tool_use'
          : 'end_turn',
        stop_sequence: null,
        container: null,
      },
      usage: { output_tokens: 1 },
    });
    add('message_stop');
    return events;
  }
  const output: ObjectValue[] = [];
  const response = {
    id: `resp_fixture_${sequence}`,
    object: 'response',
    created_at: 0,
    model,
    status: 'in_progress',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: false,
    temperature: 1,
    top_p: 1,
    tool_choice: 'auto',
    tools: request['tools'] ?? [],
    output: [],
    output_text: '',
    usage: null,
  };
  add('response.created', { response });
  add('response.in_progress', { response });
  step.blocks.forEach((block, output_index) => {
    const item_id = `item_fixture_${sequence}_${output_index}`;
    const base = { item_id, output_index };
    if (block.type === 'text') {
      const item = {
        id: item_id,
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      };
      add('response.output_item.added', { output_index, item });
      add('response.content_part.added', {
        ...base,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
      });
      for (const delta of parts(block.text))
        add('response.output_text.delta', {
          ...base,
          content_index: 0,
          delta,
          logprobs: [],
        });
      add('response.output_text.done', {
        ...base,
        content_index: 0,
        text: block.text,
        logprobs: [],
      });
      const part = {
        type: 'output_text',
        text: block.text,
        annotations: [],
        logprobs: [],
      };
      add('response.content_part.done', { ...base, content_index: 0, part });
      const completed = { ...item, status: 'completed', content: [part] };
      output.push(completed);
      add('response.output_item.done', { output_index, item: completed });
    } else {
      const item = {
        id: item_id,
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: '',
        status: 'in_progress',
      };
      add('response.output_item.added', { output_index, item });
      const args = JSON.stringify(block.input);
      for (const delta of parts(args))
        add('response.function_call_arguments.delta', { ...base, delta });
      add('response.function_call_arguments.done', {
        ...base,
        name: block.name,
        arguments: args,
      });
      const completed = { ...item, arguments: args, status: 'completed' };
      output.push(completed);
      add('response.output_item.done', { output_index, item: completed });
    }
  });
  add('response.completed', {
    response: {
      ...response,
      status: 'completed',
      output,
      output_text: step.blocks
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join(''),
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 2,
      },
    },
  });
  return events.map((event, sequence_number) => ({
    ...event,
    sequence_number,
  }));
}

/**
 * Programmatic, loopback-only fixture. Scripts must come from inspected native
 * requests; no native tool names or descendant/join semantics are assumed here.
 * Ledger chunks are emitted wire bytes, not proof the peer consumed/stored them.
 */
export function startNativeObserverProvider(options: Options) {
  requireCondition(options.steps.length <= 24, 'at most 24 scripted responses');
  const maxRequests = bound(options.maxRequests ?? 48, 48, 'request count');
  const maxRequestBytes = bound(
    options.maxRequestBytes ?? 1024 * 1024,
    1024 * 1024,
    'request bytes',
  );
  const maxResponseBytes = bound(
    options.maxResponseBytes ?? 1024 * 1024,
    1024 * 1024,
    'response bytes',
  );
  const steps = options.steps.map((step) => ({
    ...step,
    request:
      typeof step.request === 'function'
        ? step.request
        : structuredClone(step.request),
    blocks:
      typeof step.blocks === 'function'
        ? step.blocks
        : structuredClone(step.blocks),
  }));
  const compile = (
    step: NativeObserverStep,
    request: ObjectValue,
    index: number,
  ) => {
    const resolved: ResolvedStep = {
      ...step,
      blocks:
        typeof step.blocks === 'function'
          ? structuredClone(step.blocks(structuredClone(request)))
          : step.blocks,
    };
    validateStep(resolved, request);
    const chunks = eventsFor(resolved, index + 1, request).flatMap((event) =>
      parts(`event: ${event['type']}\ndata: ${JSON.stringify(event)}\n\n`),
    );
    requireCondition(
      Buffer.byteLength(chunks.join('')) <= maxResponseBytes,
      'response byte limit exceeded',
    );
    return chunks;
  };
  const streams = steps.map((step, index) =>
    typeof step.request === 'function' || typeof step.blocks === 'function'
      ? undefined
      : compile(step, step.request, index),
  );
  const records: NativeObserverRecord[] = [];
  let next = 0;
  let requests = 0;
  let failed = false;
  let reading = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 43871,
    async fetch(request) {
      // Keep one terminal cap record so capture cannot mistake an over-limit
      // health probe for a successful run, while bounding the in-memory ledger.
      if (++requests > maxRequests + 1) {
        failed = true;
        return new Response('request count exceeded', { status: 429 });
      }
      const url = new URL(request.url);
      const path = url.pathname + url.search;
      const protocol =
        path === '/v1/messages'
          ? 'messages'
          : path === '/v1/responses'
            ? 'responses'
            : undefined;
      const fakeAuth =
        protocol === 'messages'
          ? request.headers.get('x-api-key') === 'native-capture-fake'
          : request.headers.get('authorization') ===
            'Bearer native-capture-fake';
      const record: NativeObserverRecord = {
        sequence: requests,
        method: request.method,
        path,
        fakeAuth,
        decision: 'pending',
        chunks: [],
      };
      records.push(record);
      const refuse = (status: number, reason: string) => {
        failed = true;
        record.decision = reason;
        return new Response(reason, { status });
      };
      if (requests > maxRequests) return refuse(429, 'request count exceeded');
      if (failed) return refuse(409, 'fixture stopped after refusal');
      if (reading) return refuse(409, 'concurrent request read');
      // The pinned Claude CLI probes connectivity before sending model input.
      // This exact bodyless route is transport evidence, not a scripted turn.
      if (request.method === 'HEAD' && path === '/') {
        record.decision = 'health-check';
        return new Response(null, { status: 200 });
      }
      if (request.method !== 'POST' || !protocol)
        return refuse(404, 'unexpected route');
      if (!fakeAuth) return refuse(401, 'expected fixture auth');
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        return refuse(400, 'expected JSON content type');
      reading = true;
      try {
        const reader = request.body?.getReader();
        requireCondition(reader, 'missing body');
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxRequestBytes) {
            await reader.cancel();
            return refuse(413, 'request byte limit exceeded');
          }
          chunks.push(chunk.value);
        }
        record.request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (failed) return refuse(409, 'fixture stopped after refusal');
        const step = steps[next];
        if (!step) return refuse(409, 'script exhausted');
        if (step.protocol !== protocol || !object(record.request))
          return refuse(400, 'unexpected request schema or body');
        let matches: boolean;
        try {
          matches =
            typeof step.request === 'function'
              ? step.request(structuredClone(record.request)) === true
              : isDeepStrictEqual(record.request, step.request);
        } catch {
          return refuse(400, 'request predicate threw');
        }
        if (!matches) return refuse(400, 'unexpected request schema or body');
        let wire: string[];
        try {
          wire = streams[next] ?? compile(step, record.request, next);
        } catch {
          return refuse(400, 'unsupported request or response schema');
        }
        next++;
        record.decision = 'accepted';
        let chunkIndex = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (failed) {
                record.decision = 'stream stopped after refusal';
                controller.close();
                return;
              }
              const chunk = wire[chunkIndex++];
              if (chunk === undefined) {
                controller.close();
                return;
              }
              record.chunks.push(chunk);
              controller.enqueue(new TextEncoder().encode(chunk));
              // A scheduling boundary exercises incremental SDK parsing. TCP may
              // coalesce writes; a chunk is never asserted to be a transcript row.
              await Bun.sleep(1);
            },
            cancel() {
              failed = true;
              record.decision = 'stream cancelled';
            },
          }),
          {
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
            },
          },
        );
      } catch {
        return refuse(400, 'invalid JSON request');
      } finally {
        reading = false;
      }
    },
  });
  return {
    url: server.url,
    records,
    stop: async () => {
      await server.stop(true);
    },
  };
}
