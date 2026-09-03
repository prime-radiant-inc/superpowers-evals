import { expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProvider } from './linux/fixtures/fake-provider.ts';

const nodeRequire = createRequire(import.meta.url);
const ANTHROPIC_VERSION = '2023-06-01';
const GRADER_API_KEY = 'fake-grader-api-key';
const MODEL = 'claude-fake-grader-0';
const PROVIDER_CONNECT_ATTEMPTS = 60;
const PROVIDER_CONNECT_RETRY_DELAY_MS = 100;

// The full repository suite can leave a freshly-created Bun server waiting
// for its first accept window. Keep the retry bounded and give it room to
// finish inside the test timeout.
setDefaultTimeout(20_000);

interface Message {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly unknown[];
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

interface MessagesRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: Message[];
  readonly tools: ToolDefinition[];
}

interface ToolUse {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

interface ToolResponse {
  readonly content: readonly [ToolUse];
  readonly stop_reason: 'tool_use';
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
}

interface ProviderRecord {
  readonly headers: {
    readonly x_api_key: string | null;
    readonly authorization: string | null;
    readonly anthropic_version: string | null;
  };
  readonly model: string | null;
  readonly conversation_fingerprint: string;
  readonly turn: number;
}

interface AnthropicClient {
  readonly messages: {
    create(body: unknown): Promise<unknown>;
  };
}

type AnthropicConstructor = new (options: {
  readonly apiKey: string;
  readonly baseURL: string;
}) => AnthropicClient;

interface SdkRuntime {
  readonly resolve: () => string;
  readonly load: (resolvedPath: string) => unknown;
}

type FetchImplementation = (
  input: URL,
  init?: RequestInit,
) => Promise<Response>;

type FakeProvider = ReturnType<typeof startFakeProvider>;

const ALL_TOOLS = [
  makeTool('read'),
  makeTool('type_and_submit'),
  makeTool('read_screen'),
  makeTool('report_result'),
];

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `Fake provider test tool: ${name}`,
    input_schema: { type: 'object', properties: {} },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value;
}

function parseToolResponse(value: unknown): ToolResponse {
  const response = asRecord(value, 'response');
  const content = response['content'];
  if (!Array.isArray(content) || content.length !== 1) {
    throw new Error('response content was not one block');
  }
  const block = asRecord(content[0], 'response content block');
  const usage = asRecord(response['usage'], 'response usage');
  const type = block['type'];
  const id = block['id'];
  const name = block['name'];
  const input = block['input'];
  const stopReason = response['stop_reason'];
  const inputTokens = usage['input_tokens'];
  const outputTokens = usage['output_tokens'];
  if (
    type !== 'tool_use' ||
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    !isRecord(input) ||
    stopReason !== 'tool_use' ||
    typeof inputTokens !== 'number' ||
    typeof outputTokens !== 'number'
  ) {
    throw new Error('response did not have the expected tool-use shape');
  }
  return {
    content: [
      {
        type: 'tool_use',
        id,
        name,
        input,
      },
    ],
    stop_reason: 'tool_use',
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

function anthropicConstructor(
  value: unknown,
): AnthropicConstructor | undefined {
  if (typeof value === 'function') {
    return value as AnthropicConstructor;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const defaultExport = value['default'];
  if (typeof defaultExport === 'function') {
    return defaultExport as AnthropicConstructor;
  }
  const namedExport = value['Anthropic'];
  if (typeof namedExport === 'function') {
    return namedExport as AnthropicConstructor;
  }
  return undefined;
}

function isMissingAnthropicSdk(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const message = error['message'];
  const code = error['code'];
  const name = error['name'];
  return (
    typeof message === 'string' &&
    message.includes("Cannot find module '@anthropic-ai/sdk'") &&
    (code === 'MODULE_NOT_FOUND' || name === 'ResolveMessage')
  );
}

function isTransientProviderConnectionError(error: unknown): boolean {
  const candidates: unknown[] = [error];
  if (isRecord(error)) candidates.push(error['cause']);
  return candidates.some((candidate) => {
    if (!isRecord(candidate)) return false;
    return ['code', 'errno'].some((key) => {
      const value = candidate[key];
      return (
        typeof value === 'string' &&
        ['ConnectionRefused', 'FailedToOpenSocket', 'ECONNREFUSED'].includes(
          value,
        )
      );
    });
  });
}

async function withProviderConnectionRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= PROVIDER_CONNECT_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt === PROVIDER_CONNECT_ATTEMPTS ||
        !isTransientProviderConnectionError(error)
      ) {
        throw error;
      }
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, PROVIDER_CONNECT_RETRY_DELAY_MS);
      });
    }
  }
  throw new Error('provider connection retry loop did not return');
}

async function fetchProvider(
  input: URL,
  init?: RequestInit,
  fetchImpl: FetchImplementation = fetch,
): Promise<Response> {
  return withProviderConnectionRetry(() => fetchImpl(input, init));
}

const defaultSdkRuntime: SdkRuntime = {
  resolve: () => nodeRequire.resolve('@anthropic-ai/sdk'),
  load: (resolvedPath) => nodeRequire(resolvedPath),
};

function makeAnthropicClient(
  baseUrl: string,
  sdkRuntime: SdkRuntime,
): AnthropicClient | undefined {
  let resolvedPath: string;
  try {
    resolvedPath = sdkRuntime.resolve();
  } catch (error) {
    if (isMissingAnthropicSdk(error)) {
      return undefined;
    }
    throw error;
  }
  const Constructor = anthropicConstructor(sdkRuntime.load(resolvedPath));
  if (Constructor === undefined) {
    throw new Error(
      '@anthropic-ai/sdk did not expose an Anthropic constructor',
    );
  }
  return new Constructor({ apiKey: GRADER_API_KEY, baseURL: baseUrl });
}

function makeTransport(
  baseUrl: string,
  sdkRuntime: SdkRuntime = defaultSdkRuntime,
  fetchImpl: FetchImplementation = fetch,
): {
  readonly usesSdk: boolean;
  readonly send: (body: MessagesRequest) => Promise<ToolResponse>;
} {
  const client = makeAnthropicClient(baseUrl, sdkRuntime);
  if (client !== undefined) {
    return {
      usesSdk: true,
      send: async (body) =>
        parseToolResponse(
          await withProviderConnectionRetry(() => client.messages.create(body)),
        ),
    };
  }
  return {
    usesSdk: false,
    send: async (body) => {
      const response = await fetchProvider(
        new URL('/v1/messages', baseUrl),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': GRADER_API_KEY,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
        },
        fetchImpl,
      );
      expect(response.status).toBe(200);
      return parseToolResponse(await response.json());
    },
  };
}

const makeTransportWithSdkRuntime = makeTransport;

test('uses fetch only for a genuinely missing Anthropic SDK module', () => {
  const missingError = Object.assign(
    new Error("Cannot find module '@anthropic-ai/sdk'"),
    { code: 'MODULE_NOT_FOUND' },
  );
  const missingSdk = makeTransportWithSdkRuntime('http://127.0.0.1:1', {
    resolve: () => {
      throw missingError;
    },
    load: () => {
      throw new Error('the missing SDK loader must not run');
    },
  });
  expect(missingSdk.usesSdk).toBe(false);

  const unrelatedMissingError = Object.assign(
    new Error("Cannot find module '@other/provider'"),
    { code: 'MODULE_NOT_FOUND' },
  );
  expect(() =>
    makeTransportWithSdkRuntime('http://127.0.0.1:1', {
      resolve: () => {
        throw unrelatedMissingError;
      },
      load: () => {
        throw new Error('the unrelated missing loader must not run');
      },
    }),
  ).toThrow("Cannot find module '@other/provider'");
});

test('does not hide non-resolution SDK import, export, or request failures', async () => {
  const importError = new Error('SDK import failed after resolution');
  expect(() =>
    makeTransportWithSdkRuntime('http://127.0.0.1:1', {
      resolve: () => '/fake/anthropic-sdk.js',
      load: () => {
        throw importError;
      },
    }),
  ).toThrow('SDK import failed after resolution');

  expect(() =>
    makeTransportWithSdkRuntime('http://127.0.0.1:1', {
      resolve: () => '/fake/anthropic-sdk.js',
      load: () => ({}),
    }),
  ).toThrow(/Anthropic constructor/);

  const requestError = new Error('SDK request failed after construction');
  class BrokenRequestAnthropic {
    readonly messages = {
      create: async (): Promise<unknown> => {
        throw requestError;
      },
    };
  }
  const transport = makeTransportWithSdkRuntime('http://127.0.0.1:1', {
    resolve: () => '/fake/anthropic-sdk.js',
    load: () => ({ default: BrokenRequestAnthropic }),
  });
  await expect(
    transport.send(makeRequest('sdk-request-error')),
  ).rejects.toThrow('SDK request failed after construction');
});

test('retries transient provider connection failures before sending the request', async () => {
  const missingSdk = Object.assign(
    new Error("Cannot find module '@anthropic-ai/sdk'"),
    { code: 'MODULE_NOT_FOUND' },
  );
  let attempts = 0;
  const transport = makeTransportWithSdkRuntime(
    'http://127.0.0.1:1',
    {
      resolve: () => {
        throw missingSdk;
      },
      load: () => {
        throw new Error('the missing SDK loader must not run');
      },
    },
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error('provider is not listening yet'), {
          code: 'ConnectionRefused',
        });
      }
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'report_result',
              input: {
                status: 'pass',
                summary: 'retry succeeded',
                observations: [],
                reasoning: 'the provider became ready',
              },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );

  expectToolResponse(
    await transport.send(makeRequest('transient-connect')),
    'report_result',
    {
      status: 'pass',
      summary: 'retry succeeded',
      observations: [],
      reasoning: 'the provider became ready',
    },
  );
  expect(attempts).toBe(3);
});

function makeRequest(
  label: string,
  tools: ToolDefinition[] = ALL_TOOLS,
): MessagesRequest {
  return {
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: 'user', content: `begin ${label}` }],
    tools,
  };
}

interface Conversation {
  readonly launcherPath: string;
  readonly request: MessagesRequest;
}

function makeConversation(label: string): Conversation {
  return {
    launcherPath: `/tmp/fake-${label}/launch-agent`,
    request: makeRequest(label),
  };
}

function toolResultFor(tool: ToolUse, conversation: Conversation): string {
  switch (tool.name) {
    case 'read':
      return `HOWTO.md\nFAKE-SUBJECT-LAUNCHER: ${conversation.launcherPath}`;
    case 'type_and_submit':
      return 'submitted';
    case 'read_screen':
      return 'screen is ready';
    default:
      throw new Error(`cannot make a result for ${tool.name}`);
  }
}

async function sendConversationTurn(
  conversation: Conversation,
  transport: ReturnType<typeof makeTransport>,
): Promise<ToolResponse> {
  const response = await transport.send(conversation.request);
  const tool = response.content[0];
  if (tool === undefined) {
    throw new Error('fake provider returned no tool use');
  }
  conversation.request.messages.push({
    role: 'assistant',
    content: response.content,
  });
  if (tool.name !== 'report_result') {
    conversation.request.messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: tool.id,
          content: toolResultFor(tool, conversation),
        },
      ],
    });
  }
  return response;
}

function expectToolResponse(
  response: ToolResponse,
  name: string,
  input: Record<string, unknown>,
): ToolUse {
  expect(response.stop_reason).toBe('tool_use');
  expect(response.content).toHaveLength(1);
  const tool = response.content[0];
  if (tool === undefined) {
    throw new Error('missing tool response');
  }
  expect(tool.type).toBe('tool_use');
  expect(tool.id).toMatch(/^toolu_\d+$/);
  expect(tool.name).toBe(name);
  expect(tool.input).toEqual(input);
  expect(Number.isInteger(response.usage.input_tokens)).toBe(true);
  expect(response.usage.input_tokens).toBeGreaterThan(0);
  expect(Number.isInteger(response.usage.output_tokens)).toBe(true);
  expect(response.usage.output_tokens).toBeGreaterThan(0);
  return tool;
}

function readRecords(recordPath: string): ProviderRecord[] {
  if (!existsSync(recordPath)) {
    return [];
  }
  const contents = readFileSync(recordPath, 'utf8').trim();
  return contents === ''
    ? []
    : contents.split('\n').map((line) => JSON.parse(line) as ProviderRecord);
}

function expectRecordedHeaders(records: ProviderRecord[]): void {
  for (const record of records) {
    expect(Object.hasOwn(record.headers, 'x_api_key')).toBe(true);
    expect(Object.hasOwn(record.headers, 'authorization')).toBe(true);
    expect(Object.hasOwn(record.headers, 'anthropic_version')).toBe(true);
    expect(record.headers.x_api_key).toBe(GRADER_API_KEY);
    expect(record.headers.authorization).toBeNull();
    expect(record.headers.anthropic_version).toBe(ANTHROPIC_VERSION);
    expect(record.model).toBe(MODEL);
  }
}

async function withProvider<T>(
  callback: (provider: FakeProvider, recordPath: string) => Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'fake-provider-test-'));
  const recordPath = join(directory, 'requests.ndjson');
  const provider = startFakeProvider({
    bind: '127.0.0.1',
    port: 0,
    recordPath,
  });
  try {
    return await callback(provider, recordPath);
  } finally {
    await provider.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('keeps two interleaved conversations on their own four-turn scripts', async () => {
  await withProvider(async (provider, recordPath) => {
    const transport = makeTransport(provider.url.toString());
    const conversations = [
      makeConversation('alpha'),
      makeConversation('bravo'),
    ];
    const responses: ToolResponse[][] = [[], []];

    for (let turn = 0; turn < 4; turn += 1) {
      const batch = await Promise.all(
        conversations.map((conversation) =>
          sendConversationTurn(conversation, transport),
        ),
      );
      batch.forEach((response, index) => {
        responses[index]?.push(response);
      });
    }

    for (const [index, conversationResponses] of responses.entries()) {
      const conversation = conversations[index];
      if (conversation === undefined) {
        throw new Error('missing conversation');
      }
      expect(conversationResponses).toHaveLength(4);
      expectToolResponse(conversationResponses[0]!, 'read', {
        path: 'HOWTO.md',
      });
      expectToolResponse(conversationResponses[1]!, 'type_and_submit', {
        text: conversation.launcherPath,
      });
      expectToolResponse(conversationResponses[2]!, 'read_screen', {});
      const finalTool = expectToolResponse(
        conversationResponses[3]!,
        'report_result',
        {
          status: 'pass',
          summary: expect.any(String),
          observations: [],
          reasoning: expect.any(String),
        },
      );
      expect(finalTool.input['status']).toBe('pass');
      for (
        let responseIndex = 1;
        responseIndex < conversationResponses.length;
        responseIndex += 1
      ) {
        expect(
          conversationResponses[responseIndex]!.usage.input_tokens,
        ).toBeGreaterThan(
          conversationResponses[responseIndex - 1]!.usage.input_tokens,
        );
      }
      expect(
        conversationResponses.map((response) => response.content[0]!.id),
      ).toEqual(['toolu_1', 'toolu_2', 'toolu_3', 'toolu_4']);
    }

    const records = readRecords(recordPath);
    expect(records).toHaveLength(8);
    expectRecordedHeaders(records);
    const byConversation = new Map<string, number[]>();
    for (const record of records) {
      const turns = byConversation.get(record.conversation_fingerprint) ?? [];
      turns.push(record.turn);
      byConversation.set(record.conversation_fingerprint, turns);
    }
    expect(byConversation.size).toBe(2);
    expect([...byConversation.values()]).toEqual([
      [1, 2, 3, 4],
      [1, 2, 3, 4],
    ]);
  });
});

test('uses report_result for the grace turn and for unrecognized tool shapes', async () => {
  await withProvider(async (provider, recordPath) => {
    const transport = makeTransport(provider.url.toString());
    const graceRequest = makeRequest('grace', [makeTool('report_result')]);
    expect(graceRequest.tools.map((tool) => tool.name)).toEqual([
      'report_result',
    ]);
    const grace = await transport.send(graceRequest);
    expectToolResponse(grace, 'report_result', {
      status: 'pass',
      summary: expect.any(String),
      observations: [],
      reasoning: expect.any(String),
    });

    const fallback = await transport.send(
      makeRequest('unrecognized', [makeTool('unexpected_tool')]),
    );
    expectToolResponse(fallback, 'report_result', {
      status: 'investigate',
      summary: expect.any(String),
      observations: [],
      reasoning: expect.any(String),
    });

    const records = readRecords(recordPath);
    expect(records).toHaveLength(2);
    expectRecordedHeaders(records);
  });
});

test('treats malformed messages and tool entries as unrecognized shapes', async () => {
  await withProvider(async (provider) => {
    const transport = makeTransport(provider.url.toString());
    const malformedMessages = {
      ...makeRequest('malformed-messages'),
      messages: [{ role: 'user' }] as unknown as Message[],
    };
    const messageFallback = await transport.send(malformedMessages);
    expectToolResponse(messageFallback, 'report_result', {
      status: 'investigate',
      summary: expect.any(String),
      observations: [],
      reasoning: expect.any(String),
    });

    const malformedTools = {
      ...makeRequest('malformed-tools'),
      tools: [makeTool('report_result'), {}] as ToolDefinition[],
    };
    const toolFallback = await transport.send(malformedTools);
    expectToolResponse(toolFallback, 'report_result', {
      status: 'investigate',
      summary: expect.any(String),
      observations: [],
      reasoning: expect.any(String),
    });
  });
});

test('returns 404 for every route except POST /v1/messages', async () => {
  await withProvider(async (provider) => {
    const getMessages = await fetchProvider(
      new URL('/v1/messages', provider.url),
      { method: 'GET' },
    );
    expect(getMessages.status).toBe(404);

    const otherPath = await fetchProvider(new URL('/v1/other', provider.url), {
      method: 'POST',
    });
    expect(otherPath.status).toBe(404);

    const trailingSlash = await fetchProvider(
      new URL('/v1/messages/', provider.url),
      { method: 'POST' },
    );
    expect(trailingSlash.status).toBe(404);
  });
});
