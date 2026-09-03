import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FakeProviderOptions {
  readonly bind: string;
  readonly port: number;
  readonly recordPath: string;
}

export interface FakeProvider {
  readonly url: URL;
  readonly stop: () => Promise<void>;
}

interface JsonObject {
  readonly [key: string]: unknown;
}

interface Message extends JsonObject {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly unknown[];
}

interface ToolUseResponse {
  readonly name: string;
  readonly input: JsonObject;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isToolResultContent(value: unknown): boolean {
  if (typeof value === 'string') {
    return true;
  }
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (block) => isJsonObject(block) && typeof block['type'] === 'string',
    )
  );
}

function isContentBlock(value: unknown): value is JsonObject {
  if (!isJsonObject(value) || typeof value['type'] !== 'string') {
    return false;
  }
  switch (value['type']) {
    case 'text':
      return typeof value['text'] === 'string';
    case 'tool_use':
      return (
        typeof value['id'] === 'string' &&
        typeof value['name'] === 'string' &&
        isJsonObject(value['input'])
      );
    case 'tool_result':
      return (
        typeof value['tool_use_id'] === 'string' &&
        isToolResultContent(value['content'])
      );
    default:
      return true;
  }
}

function isMessage(value: unknown): value is Message {
  if (!isJsonObject(value)) {
    return false;
  }
  const role = value['role'];
  const content = value['content'];
  return (
    (role === 'user' || role === 'assistant') &&
    ((typeof content === 'string' && content.length > 0) ||
      (Array.isArray(content) &&
        content.length > 0 &&
        content.every(isContentBlock)))
  );
}

function messagesFrom(body: JsonObject): readonly Message[] | undefined {
  const messages = body['messages'];
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    !messages.every(isMessage)
  ) {
    return undefined;
  }
  return messages as Message[];
}

function toolsFrom(body: JsonObject): readonly string[] | undefined {
  const tools = body['tools'];
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }
  const names: string[] = [];
  for (const tool of tools) {
    if (
      !isJsonObject(tool) ||
      typeof tool['name'] !== 'string' ||
      tool['name'].length === 0 ||
      !isJsonObject(tool['input_schema'])
    ) {
      return undefined;
    }
    names.push(tool['name']);
  }
  return names;
}

function hasToolResultBatch(message: Message): boolean {
  if (message['role'] !== 'user' || !Array.isArray(message['content'])) {
    return false;
  }
  return message['content'].some((block: unknown) => {
    return isJsonObject(block) && block['type'] === 'tool_result';
  });
}

function assistantTurnCount(messages: readonly Message[]): number {
  return messages.filter((message) => message['role'] === 'assistant').length;
}

function toolResultBatchCount(messages: readonly Message[]): number {
  return messages.filter(hasToolResultBatch).length;
}

function inferredTurn(body: JsonObject): number | undefined {
  const messages = messagesFrom(body);
  if (messages === undefined) {
    return undefined;
  }
  const assistantTurns = assistantTurnCount(messages);
  const toolResultBatches = toolResultBatchCount(messages);
  if (assistantTurns !== toolResultBatches) {
    return undefined;
  }
  return assistantTurns + 1;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .flatMap((block: unknown) => {
      if (!isJsonObject(block) || block['type'] !== 'text') {
        return [];
      }
      const text = block['text'];
      return typeof text === 'string' ? [text] : [];
    })
    .join('\n');
}

function toolResultText(body: JsonObject): string {
  return (messagesFrom(body) ?? [])
    .flatMap((message) => {
      if (message['role'] !== 'user' || !Array.isArray(message['content'])) {
        return [];
      }
      return message['content'].flatMap((block: unknown) => {
        if (!isJsonObject(block) || block['type'] !== 'tool_result') {
          return [];
        }
        return [textFromContent(block['content'])];
      });
    })
    .join('\n');
}

function launcherPathFrom(body: JsonObject): string | undefined {
  const match = toolResultText(body).match(
    /FAKE-SUBJECT-LAUNCHER:\s*(\/[^\s]+)/,
  );
  return match?.[1];
}

function conversationFingerprint(body: JsonObject): string {
  const messages = messagesFrom(body) ?? [];
  const firstUserMessage = messages.find(
    (message) => message['role'] === 'user',
  );
  const serialized = JSON.stringify(firstUserMessage ?? 'unknown') ?? 'unknown';
  let hash = 2166136261;
  for (const character of serialized) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `conv_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function reportResult(
  status: 'pass' | 'investigate',
  inputTokens: number,
  outputTokens: number,
  idNumber: number,
): Response {
  const summary =
    status === 'pass'
      ? 'Fake provider completed the requested turn sequence.'
      : 'Fake provider could not recognize the request shape.';
  const reasoning =
    status === 'pass'
      ? 'The fake provider received the expected scripted tool history.'
      : 'The fake provider returns an investigate result instead of text for unknown input.';
  return jsonResponse({
    content: [
      {
        type: 'tool_use',
        id: `toolu_${idNumber}`,
        name: 'report_result',
        input: {
          status,
          summary,
          observations: [],
          reasoning,
        },
      },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
}

function scriptedTool(
  tool: ToolUseResponse,
  inputTokens: number,
  outputTokens: number,
  idNumber: number,
): Response {
  return jsonResponse({
    content: [
      {
        type: 'tool_use',
        id: `toolu_${idNumber}`,
        name: tool.name,
        input: tool.input,
      },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
}

function jsonResponse(body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}

function responseFor(body: JsonObject): Response {
  const messages = messagesFrom(body);
  const turn = inferredTurn(body);
  const toolNames = toolsFrom(body);
  const inputTokens = 100 + (messages?.length ?? 0) * 10;
  const outputTokens = 20 + (turn ?? 1);
  const idNumber = Math.max(turn ?? 1, 1);

  if (
    messages !== undefined &&
    toolNames?.length === 1 &&
    toolNames[0] === 'report_result'
  ) {
    return reportResult('pass', inputTokens, outputTokens, idNumber);
  }
  if (turn === 1 && toolNames?.includes('read')) {
    return scriptedTool(
      { name: 'read', input: { path: 'HOWTO.md' } },
      inputTokens,
      outputTokens,
      idNumber,
    );
  }
  if (turn === 2 && toolNames?.includes('type_and_submit')) {
    const path = launcherPathFrom(body);
    if (path !== undefined) {
      return scriptedTool(
        { name: 'type_and_submit', input: { text: path } },
        inputTokens,
        outputTokens,
        idNumber,
      );
    }
  }
  if (turn === 3 && toolNames?.includes('read_screen')) {
    return scriptedTool(
      { name: 'read_screen', input: {} },
      inputTokens,
      outputTokens,
      idNumber,
    );
  }
  if (turn === 4 && toolNames?.includes('report_result')) {
    return reportResult('pass', inputTokens, outputTokens, idNumber);
  }
  return reportResult('investigate', inputTokens, outputTokens, idNumber);
}

function recordRequest(
  request: Request,
  body: JsonObject,
  recordPath: string,
): void {
  const record = {
    headers: {
      x_api_key: request.headers.get('x-api-key'),
      authorization: request.headers.get('authorization'),
      anthropic_version: request.headers.get('anthropic-version'),
    },
    model: typeof body['model'] === 'string' ? body['model'] : null,
    conversation_fingerprint: conversationFingerprint(body),
    turn: inferredTurn(body) ?? 0,
  };
  appendFileSync(recordPath, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function fakeProviderHandler(
  request: Request,
  recordPath: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/v1/messages') {
    return new Response('Not Found', { status: 404 });
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    parsed = {};
  }
  const body = isJsonObject(parsed) ? parsed : {};
  recordRequest(request, body, recordPath);
  return responseFor(body);
}

export function startFakeProvider(options: FakeProviderOptions): FakeProvider {
  mkdirSync(dirname(options.recordPath), { recursive: true });
  const server = Bun.serve({
    fetch: (request) => fakeProviderHandler(request, options.recordPath),
    hostname: options.bind,
    port: options.port,
  });
  return {
    url: server.url,
    stop: () => server.stop(true),
  };
}

function parseCliArgs(argv: readonly string[]): FakeProviderOptions {
  let bind: string | undefined;
  let port: number | undefined;
  let recordPath: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`missing value for ${flag ?? 'argument'}`);
    }
    switch (flag) {
      case '--bind':
        bind = value;
        break;
      case '--port':
        port = Number(value);
        break;
      case '--record':
        recordPath = value;
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  if (bind === undefined || port === undefined || recordPath === undefined) {
    throw new Error(
      'usage: fake-provider.ts --bind <addr> --port <p> --record <file>',
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port ${port}`);
  }
  return { bind, port, recordPath };
}

if (import.meta.main) {
  startFakeProvider(parseCliArgs(Bun.argv.slice(2)));
}
