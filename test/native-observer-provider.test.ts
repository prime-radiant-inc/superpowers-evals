import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getEnv } from '../src/env.ts';
import {
  type NativeObserverBlock,
  startNativeObserverProvider,
} from './linux/fixtures/native-observer-provider.ts';

const schema = {
  type: 'object',
  properties: { note: { type: 'string' } },
  required: ['note'],
  additionalProperties: false,
};
const bodies = {
  messages: {
    model: 'fixture-model',
    stream: true,
    max_tokens: 128,
    messages: [{ role: 'user', content: 'fixture request' }],
    tools: [{ name: 'fixture_note', input_schema: schema }],
  },
  responses: {
    model: 'fixture-model',
    stream: true,
    input: [{ role: 'user', content: 'fixture request' }],
    tools: [
      {
        type: 'function',
        name: 'fixture_note',
        parameters: schema,
        strict: true,
      },
    ],
  },
};

async function post(
  url: URL,
  route: string,
  body: unknown,
  signal?: AbortSignal,
) {
  return fetch(new URL(`/v1/${route}`, url), {
    method: 'POST',
    proxy: '',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'native-capture-fake',
      authorization: 'Bearer native-capture-fake',
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

test('streams both protocols over localhost and preserves split tool input and text', async () => {
  const server = startNativeObserverProvider({
    port: 0,
    steps: Object.entries(bodies).map(([protocol, request]) => ({
      protocol: protocol as 'messages' | 'responses',
      request,
      blocks: [
        { type: 'text', text: 'hello 🌱' },
        {
          type: 'tool',
          id: 'call_fixture',
          name: 'fixture_note',
          input: { note: 'done' },
        },
      ],
    })),
  });
  try {
    for (const protocol of ['messages', 'responses'] as const) {
      const response = await post(server.url, protocol, bodies[protocol]);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      const events = (await response.text())
        .trim()
        .split('\n\n')
        .map((event) => JSON.parse(event.split('\ndata: ')[1]!));
      const text = events.flatMap((event) =>
        protocol === 'messages'
          ? event.delta?.type === 'text_delta'
            ? [event.delta.text]
            : []
          : event.type === 'response.output_text.delta'
            ? [event.delta]
            : [],
      );
      const input = events.flatMap((event) =>
        protocol === 'messages'
          ? event.delta?.type === 'input_json_delta'
            ? [event.delta.partial_json]
            : []
          : event.type === 'response.function_call_arguments.delta'
            ? [event.delta]
            : [],
      );
      expect(text.length).toBeGreaterThan(1);
      expect(text.join('')).toBe('hello 🌱');
      expect(input.length).toBeGreaterThan(1);
      expect(JSON.parse(input.join(''))).toEqual({ note: 'done' });
      expect(events.at(-1).type).toBe(
        protocol === 'messages' ? 'message_stop' : 'response.completed',
      );
    }
    expect(server.records.map((record) => record.decision)).toEqual([
      'accepted',
      'accepted',
    ]);
    expect(server.records.every((record) => record.chunks.length > 2)).toBe(
      true,
    );
  } finally {
    await server.stop();
  }
});

test('refuses unexpected request bodies and latches failure before any scripted response', async () => {
  const server = startNativeObserverProvider({
    port: 0,
    steps: [
      {
        protocol: 'messages',
        request: bodies.messages,
        blocks: [{ type: 'text', text: 'never' }],
      },
    ],
  });
  try {
    expect(
      (
        await post(server.url, 'messages', {
          ...bodies.messages,
          stream: false,
        })
      ).status,
    ).toBe(400);
    expect((await post(server.url, 'messages', bodies.messages)).status).toBe(
      409,
    );
    expect(server.records.every((record) => record.chunks.length === 0)).toBe(
      true,
    );
  } finally {
    await server.stop();
  }
});

test('stops an active stream when a later request violates the script', async () => {
  const server = startNativeObserverProvider({
    port: 0,
    steps: [
      {
        protocol: 'messages',
        request: bodies.messages,
        blocks: [{ type: 'text', text: 'unfinished response' }],
      },
    ],
  });
  try {
    const active = await post(server.url, 'messages', bodies.messages);
    expect((await post(server.url, 'unknown', {})).status).toBe(404);
    // A refusal must prevent the already accepted stream reaching its terminal
    // event, even if its HTTP headers have already been sent.
    await active.text().catch(() => 'closed transport');
    expect(server.records[0]?.decision).toBe('stream stopped after refusal');
  } finally {
    await server.stop();
  }
});

test('aborting a real HTTP stream latches refusal and stops further chunks', async () => {
  const server = startNativeObserverProvider({
    port: 0,
    steps: [
      {
        protocol: 'messages',
        request: bodies.messages,
        blocks: Array.from({ length: 8 }, () => ({
          type: 'text' as const,
          text: 'unfinished response',
        })),
      },
      {
        protocol: 'messages',
        request: bodies.messages,
        blocks: [{ type: 'text', text: 'must not be served' }],
      },
    ],
  });
  try {
    const controller = new AbortController();
    const response = await post(
      server.url,
      'messages',
      bodies.messages,
      controller.signal,
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value!.byteLength).toBeGreaterThan(0);
    await reader.cancel();
    // Bun's reader cancellation discards the body without disconnecting HTTP.
    // Abort the request explicitly so the server observes the abandoned stream.
    controller.abort();
    // HTTP cancellation reaches the server asynchronously; bound the wait for
    // its receipt instead of treating the client-side promise as server proof.
    for (
      let attempt = 0;
      attempt < 100 && server.records[0]?.decision !== 'stream cancelled';
      attempt++
    ) {
      await Bun.sleep(2);
    }
    expect(server.records[0]?.decision).toBe('stream cancelled');
    const chunksAfterCancellation = server.records[0]!.chunks.length;
    const refused = await post(server.url, 'messages', bodies.messages);
    expect(refused.status).toBe(409);
    await refused.text();
    await Bun.sleep(5);
    expect(server.records[0]!.chunks).toHaveLength(chunksAfterCancellation);
    expect(server.records[1]?.chunks).toEqual([]);
    expect((await reader.read()).done).toBe(true);
  } finally {
    await server.stop();
  }
});

test('an explicit predicate binds dynamic request IDs while responses stay scripted', async () => {
  let captured: unknown;
  const first = (body: Record<string, unknown>) => {
    const metadata = body['metadata'] as Record<string, unknown>;
    if (typeof metadata?.['fixture_id'] !== 'string') return false;
    captured = metadata['fixture_id'];
    return true;
  };
  const next = (body: Record<string, unknown>) =>
    (body['metadata'] as Record<string, unknown>)?.['fixture_id'] === captured;
  const server = startNativeObserverProvider({
    port: 0,
    steps: [first, next, next].map((request) => ({
      protocol: 'responses',
      request,
      blocks: [{ type: 'text', text: 'fixed reply' }],
    })),
  });
  const request = {
    ...bodies.responses,
    metadata: { fixture_id: crypto.randomUUID() },
  };
  try {
    for (let index = 0; index < 2; index++) {
      const response = await post(server.url, 'responses', request);
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(
      (
        await post(server.url, 'responses', {
          ...request,
          metadata: { fixture_id: 'wrong-id' },
        })
      ).status,
    ).toBe(400);
    expect(server.records[0]?.request).toEqual(request);
    expect(server.records[1]?.request).toEqual(request);
    expect(server.records[2]?.chunks).toEqual([]);
  } finally {
    await server.stop();
  }
});

test('a request predicate cannot bypass advertised-tool schema validation', async () => {
  const server = startNativeObserverProvider({
    port: 0,
    steps: [
      {
        protocol: 'responses',
        request: () => true,
        blocks: [
          {
            type: 'tool',
            name: 'fixture_note',
            id: 'call_fixture',
            input: { note: 'done' },
          },
        ],
      },
    ],
  });
  try {
    expect(
      (await post(server.url, 'responses', { ...bodies.responses, tools: [] }))
        .status,
    ).toBe(400);
    expect(server.records[0]?.chunks).toEqual([]);
  } finally {
    await server.stop();
  }
});

test('a response factory uses an observed toy child ID in a later advertised join tool', async () => {
  // These are fictional test tools, not a claim about either native CLI.
  const request = {
    ...bodies.responses,
    tools: [
      ...bodies.responses.tools,
      {
        type: 'function',
        name: 'fixture_join',
        parameters: {
          type: 'object',
          properties: { child_id: { type: 'string' } },
          required: ['child_id'],
          additionalProperties: false,
        },
      },
    ],
  };
  let childId: string | undefined;
  const server = startNativeObserverProvider({
    port: 0,
    steps: [
      {
        protocol: 'responses',
        request,
        blocks: [
          {
            type: 'tool',
            name: 'fixture_note',
            id: 'call_fixture_create',
            input: { note: 'toy child' },
          },
        ],
      },
      {
        protocol: 'responses',
        request: (body) => {
          const result = (body['input'] as Record<string, unknown>[]).at(-1)!;
          if (
            result['type'] !== 'function_call_output' ||
            result['call_id'] !== 'call_fixture_create' ||
            typeof result['output'] !== 'string'
          )
            return false;
          const observed = JSON.parse(result['output']) as {
            fixture_child_id?: unknown;
          };
          if (typeof observed.fixture_child_id !== 'string') return false;
          childId = observed.fixture_child_id;
          return true;
        },
        blocks: (body) => {
          const result = (body['input'] as Record<string, unknown>[]).at(-1)!;
          if (result['call_id'] !== 'call_fixture_create') {
            throw new Error('unexpected toy tool result');
          }
          return [
            {
              type: 'tool',
              name: 'fixture_join',
              id: 'call_fixture_join',
              input: { child_id: childId },
            },
          ];
        },
      },
    ],
  });
  try {
    const created = await post(server.url, 'responses', request);
    expect(created.status).toBe(200);
    const creation = (await created.text())
      .trim()
      .split('\n\n')
      .map((event) => JSON.parse(event.split('\ndata: ')[1]!))
      .at(-1).response.output[0];
    expect(creation.name).toBe('fixture_note');
    const observedId = crypto.randomUUID();
    const joined = await post(server.url, 'responses', {
      ...request,
      input: [
        ...request.input,
        {
          type: 'function_call_output',
          call_id: creation.call_id,
          output: JSON.stringify({ fixture_child_id: observedId }),
        },
      ],
    });
    expect(joined.status).toBe(200);
    const joinCall = (await joined.text())
      .trim()
      .split('\n\n')
      .map((event) => JSON.parse(event.split('\ndata: ')[1]!))
      .at(-1).response.output[0];
    expect(joinCall.name).toBe('fixture_join');
    expect(JSON.parse(joinCall.arguments)).toEqual({ child_id: observedId });
  } finally {
    await server.stop();
  }
});

test('invalid factory output, unadvertised tools, arguments and oversized responses refuse before SSE', async () => {
  const invalid: unknown[] = [
    null,
    [],
    [{ type: 'invented' }],
    [{ type: 'tool', name: 'not_advertised', id: 'call_fixture', input: {} }],
    [
      {
        type: 'tool',
        name: 'fixture_note',
        id: 'call_fixture',
        input: { note: 2 },
      },
    ],
    [{ type: 'text', text: 'x'.repeat(2048) }],
  ];
  for (const blocks of invalid) {
    const server = startNativeObserverProvider({
      port: 0,
      maxResponseBytes: 1024,
      steps: [
        {
          protocol: 'responses',
          request: bodies.responses,
          blocks: () => blocks as NativeObserverBlock[],
        },
      ],
    });
    try {
      expect(
        (await post(server.url, 'responses', bodies.responses)).status,
      ).toBe(400);
      expect(server.records[0]?.chunks).toEqual([]);
    } finally {
      await server.stop();
    }
  }
});

test('refuses unknown routes, invalid auth, malformed JSON, and exhausted scripts', async () => {
  for (const failure of ['route', 'auth', 'json', 'exhausted']) {
    const server = startNativeObserverProvider({ port: 0, steps: [] });
    try {
      const response = await fetch(
        new URL(
          failure === 'route' ? '/v1/responses/compact' : '/v1/messages',
          server.url,
        ),
        {
          method: 'POST',
          proxy: '',
          headers: {
            'content-type': 'application/json',
            'x-api-key':
              failure === 'auth' ? 'not-fixture' : 'native-capture-fake',
          },
          body: failure === 'json' ? '{' : JSON.stringify(bodies.messages),
        },
      );
      expect(response.status).toBe(
        failure === 'route'
          ? 404
          : failure === 'auth'
            ? 401
            : failure === 'json'
              ? 400
              : 409,
      );
      expect(server.records[0]?.chunks).toEqual([]);
    } finally {
      await server.stop();
    }
  }
});

test('refuses unadvertised tools, invalid arguments and unsupported schemas at startup', () => {
  for (const [name, input, inputSchema] of [
    ['invented_tool', { note: 'done' }, schema],
    ['fixture_note', { note: 1 }, schema],
    ['fixture_note', { note: 'done', extra: true }, schema],
    ['fixture_note', {}, schema],
    ['fixture_note', { note: 'done' }, { ...schema, allOf: [] }],
  ] as const) {
    expect(() =>
      startNativeObserverProvider({
        port: 0,
        steps: [
          {
            protocol: 'messages',
            request: {
              ...bodies.messages,
              tools: [{ name: 'fixture_note', input_schema: inputSchema }],
            },
            blocks: [{ type: 'tool', id: 'call_fixture', name, input }],
          },
        ],
      }),
    ).toThrow();
  }
});

test('enforces response, request and byte bounds without serving excess output', async () => {
  expect(() =>
    startNativeObserverProvider({
      port: 0,
      steps: Array.from({ length: 25 }, () => ({
        protocol: 'messages' as const,
        request: bodies.messages,
        blocks: [{ type: 'text' as const, text: 'x' }],
      })),
    }),
  ).toThrow();
  const server = startNativeObserverProvider({
    port: 0,
    maxRequests: 1,
    maxRequestBytes: 32,
    steps: [],
  });
  try {
    expect((await post(server.url, 'messages', bodies.messages)).status).toBe(
      413,
    );
    expect((await post(server.url, 'messages', {})).status).toBe(429);
    expect(server.records).toHaveLength(1);
  } finally {
    await server.stop();
  }
  expect(() =>
    startNativeObserverProvider({
      port: 0,
      maxResponseBytes: 64,
      steps: [
        {
          protocol: 'messages',
          request: bodies.messages,
          blocks: [{ type: 'text', text: 'large stream' }],
        },
      ],
    }),
  ).toThrow();
});

// SDK source is supplied by the explicitly selected Gauntlet checkout. There is
// no fetch fallback: import/consumer failure fails this opt-in protocol check.
const gauntletRoot = getEnv('GAUNTLET_ROOT');
test.skipIf(!gauntletRoot)(
  'official SDK accumulators consume the emitted SSE into final messages and function calls',
  async () => {
    const require = createRequire(join(gauntletRoot!, 'package.json'));
    interface Stream {
      finalMessage?(): Promise<Record<string, unknown>>;
      finalResponse?(): Promise<Record<string, unknown>>;
    }
    type Client = {
      messages: { stream(body: unknown): Stream };
      responses: { stream(body: unknown): Stream };
    };
    type Constructor = new (options: unknown) => Client;
    for (const protocol of ['messages', 'responses'] as const) {
      const module = require(
        protocol === 'messages' ? '@anthropic-ai/sdk' : 'openai',
      ) as { default: Constructor };
      const server = startNativeObserverProvider({
        port: 0,
        steps: [
          {
            protocol,
            request: bodies[protocol],
            blocks: [
              { type: 'text', text: 'hello 🌱' },
              {
                type: 'tool',
                id: 'call_fixture',
                name: 'fixture_note',
                input: { note: 'done' },
              },
            ],
          },
        ],
      });
      try {
        const client = new module.default({
          apiKey: 'native-capture-fake',
          baseURL: new URL(protocol === 'messages' ? '/' : '/v1', server.url)
            .href,
          maxRetries: 0,
          fetch: (url: string, init: RequestInit) =>
            fetch(url, { ...init, proxy: '' }),
        });
        const stream = client[protocol].stream(bodies[protocol]);
        const result =
          protocol === 'messages'
            ? await stream.finalMessage!()
            : await stream.finalResponse!();
        if (protocol === 'messages') {
          expect(result['content']).toEqual([
            { type: 'text', text: 'hello 🌱' },
            {
              type: 'tool_use',
              id: 'call_fixture',
              name: 'fixture_note',
              input: { note: 'done' },
            },
          ]);
          expect(result['stop_reason']).toBe('tool_use');
        } else {
          expect(result['output_text']).toBe('hello 🌱');
          expect(result['output']).toMatchObject([
            { content: [{ text: 'hello 🌱' }] },
            {
              type: 'function_call',
              call_id: 'call_fixture',
              arguments: '{"note":"done"}',
            },
          ]);
          expect(result['status']).toBe('completed');
        }
      } finally {
        await server.stop();
      }
    }
  },
);
