// Invented native records exercising each supported result envelope. No incident data.
import { normalizeClaudeLegacy } from '../../../src/normalize/claude.ts';
import { normalizeCodex } from '../../../src/normalize/codex.ts';
import { normalizePi } from '../../../src/normalize/pi.ts';

export const NATIVE_RESULT_CASES = [
  'claude',
  'pi',
  'codex-metadata',
  'codex-exec',
] as const;
export function nativeReadResult(
  kind: (typeof NATIVE_RESULT_CASES)[number],
  path: string,
  failed: boolean,
) {
  const output = failed ? 'ENOENT: file not found' : 'Synthetic file content';
  if (kind === 'claude')
    return normalizeClaudeLegacy(
      [
        {
          type: 'assistant',
          message: {
            id: 'read',
            content: [
              {
                type: 'tool_use',
                name: 'Read',
                id: 'read',
                input: { file_path: path },
              },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'read',
                content: output,
                is_error: failed,
              },
            ],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n'),
      'synthetic',
    );
  if (kind === 'pi')
    return normalizePi(
      [
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                name: 'read',
                id: 'read',
                arguments: { path },
              },
            ],
          },
        },
        {
          type: 'message',
          message: {
            role: 'toolResult',
            toolCallId: 'read',
            content: output,
            isError: failed,
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n'),
      'synthetic',
    );
  return normalizeCodex(
    [
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'read',
          arguments: JSON.stringify({ cmd: `cat ${path}` }),
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'read',
          output:
            kind === 'codex-metadata'
              ? JSON.stringify({
                  output,
                  metadata: { exit_code: failed ? 1 : 0 },
                })
              : [
                  {
                    type: 'input_text',
                    text: 'Script completed\nWall time 0.1 seconds\nOutput:\n',
                  },
                  {
                    type: 'input_text',
                    text: JSON.stringify({
                      chunk_id: 'synthetic',
                      wall_time_seconds: 0.01,
                      exit_code: failed ? 1 : 0,
                      original_token_count: 5,
                      output,
                    }),
                  },
                ],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n'),
    'synthetic',
  );
}

export function nativeDurationBoundary(
  harness: 'claude' | 'codex',
  durationMs?: number,
  timestamp?: string,
) {
  const row =
    harness === 'claude'
      ? {
          type: 'system',
          subtype: 'turn_duration',
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(timestamp ? { timestamp } : {}),
        }
      : {
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
          },
          ...(timestamp ? { timestamp } : {}),
        };
  // Two blank native lines put the literal boundary at the frozen locator 3.
  return (harness === 'claude' ? normalizeClaudeLegacy : normalizeCodex)(
    `\n\n${JSON.stringify(row)}`,
    'synthetic',
  );
}

export function nativeDurationResult(
  harness: 'claude' | 'pi',
  durationMs?: number,
  parallel = false,
) {
  if (harness === 'claude')
    return normalizeClaudeLegacy(
      `\n${[
        {
          type: 'assistant',
          message: {
            id: 'agent',
            content: [
              {
                type: 'tool_use',
                name: 'Agent',
                id: 'agent',
                input: { prompt: 'Synthetic analysis' },
              },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'agent',
                content: 'Synthetic result',
              },
            ],
          },
          toolUseResult: {
            ...(durationMs !== undefined
              ? { totalDurationMs: durationMs }
              : {}),
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n')}`,
      'synthetic',
    );
  const child = {
    sessionFile: '/synthetic/child.jsonl',
    progressSummary: durationMs === undefined ? {} : { durationMs },
  };
  return normalizePi(
    `\n${[
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              name: 'subagent',
              id: 'agent',
              arguments: { agent: 'analyst', task: 'Synthetic analysis' },
            },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'agent',
          content: 'Synthetic result',
          details: {
            mode: parallel ? 'parallel' : 'single',
            results: parallel
              ? [child, { ...child, sessionFile: '/synthetic/other.jsonl' }]
              : [child],
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}`,
    'synthetic',
  );
}
