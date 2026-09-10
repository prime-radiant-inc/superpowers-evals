// Offline native-report analysis and fenced SDK serialization only. No live entrypoint.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ReconstructedRequest } from './reconstruct.ts';

export function classifyDiagnosticResponse(input: {
  sdkContent: unknown;
  arguments: unknown;
  criterionCount: number;
  exposedPaths: Set<string>;
  validate(
    arguments_: unknown,
    count: number,
    paths: Set<string>,
  ): { ok: boolean; reason?: string };
}): { kind: 'valid_report' | 'invalid_report' | 'non_report'; reason: string } {
  const nativeReports = Array.isArray(input.sdkContent)
    ? input.sdkContent.filter(
        (b) => b?.type === 'tool_use' && b?.name === 'report_result',
      )
    : [];
  if (nativeReports.length > 1)
    return { kind: 'invalid_report', reason: 'multiple native reports' };
  if (input.arguments === undefined && nativeReports.length === 0)
    return { kind: 'non_report', reason: 'no native report' };
  const result = input.validate(
    input.arguments,
    input.criterionCount,
    input.exposedPaths,
  );
  if (
    result.ok &&
    (nativeReports.length !== 1 ||
      JSON.stringify(nativeReports[0].input) !==
        JSON.stringify(input.arguments))
  ) {
    return {
      kind: 'invalid_report',
      reason: 'native report absent or adapted arguments changed',
    };
  }
  return {
    kind: result.ok ? 'valid_report' : 'invalid_report',
    reason:
      result.reason ??
      (result.ok ? 'native report validated' : 'native report rejected'),
  };
}

/** Serialize once with synthetic auth and a private in-memory fetch. Neither a
 * transport override nor the SDK client is exposed to callers. */
export async function serializeDiagnosticRequest(input: {
  gRoot: string;
  reconstruction: ReconstructedRequest;
}): Promise<string> {
  const pkg = JSON.parse(
    readFileSync(
      join(input.gRoot, 'node_modules/@anthropic-ai/sdk/package.json'),
      'utf8',
    ),
  );
  if (pkg.version !== '0.78.0') throw Error('SDK pin mismatch');
  const { default: Anthropic } = await import(
    pathToFileURL(join(input.gRoot, 'node_modules/@anthropic-ai/sdk/index.mjs'))
      .href
  );
  let bytes: string | undefined;
  const intercept = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (bytes !== undefined) throw Error('offline serialization repeated');
    const request =
      url instanceof Request
        ? new Request(url, init)
        : new Request(String(url), init);
    if (
      request.url !==
      `${input.reconstruction.endpoint.replace(/\/$/, '')}/v1/messages`
    )
      throw Error('diagnostic endpoint mismatch');
    bytes = await request.text();
    return Response.json({
      id: 'offline',
      type: 'message',
      role: 'assistant',
      model: input.reconstruction.model,
      content: [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }) as typeof fetch;
  const client = new Anthropic({
    apiKey: 'offline-synthetic',
    authToken: null,
    baseURL: input.reconstruction.endpoint,
    fetch: intercept,
    maxRetries: 0,
  });
  await client.messages.create(input.reconstruction.body, {
    signal: AbortSignal.timeout(1000),
    timeout: 1000,
  });
  if (bytes === undefined) throw Error('offline SDK did not serialize');
  return bytes;
}
