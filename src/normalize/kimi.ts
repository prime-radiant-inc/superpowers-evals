import { readFileSync } from 'node:fs';
import {
  ATIF_SCHEMA_VERSION,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import { validateTrajectory } from '../atif/validate.ts';

interface KimiEntry {
  type?: string;
  event?: {
    type?: string;
    name?: string;
    args?: unknown;
  };
}

/**
 * Convert a Kimi Code wire.jsonl session log into an ATIF v1.7 trajectory.
 *
 * Kimi records tool invocations as context loop events:
 *   {"type":"context.append_loop_event",
 *    "event":{"type":"tool.call","name":"Read","args":{...}}}
 *
 * Tool names are already in Claude-Code canonical form; the only rewrite is
 * canonicalizing bare superpowers skill names (e.g. "brainstorming" →
 * "superpowers:brainstorming") on Skill calls.
 */
export function normalizeKimi(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 1;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: KimiEntry;
    try {
      entry = JSON.parse(line) as KimiEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (entry['type'] !== 'context.append_loop_event') continue;

    const event = entry['event'];
    if (!event || typeof event !== 'object') continue;
    if (event['type'] !== 'tool.call') continue;

    const name = event['name'];
    if (typeof name !== 'string' || !name) continue;

    const rawArgs = event['args'];
    const args: Record<string, unknown> =
      typeof rawArgs === 'object' && rawArgs !== null
        ? { ...(rawArgs as Record<string, unknown>) }
        : { raw_args: rawArgs };

    if (name === 'Skill') {
      const skill = args['skill'];
      if (typeof skill === 'string' && skill && !skill.includes(':')) {
        args['skill'] = `superpowers:${skill}`;
      }
    }

    const tc: AtifToolCall = {
      tool_call_id: `${stepId}`,
      function_name: name,
      arguments: args,
    };

    steps.push({
      step_id: stepId++,
      source: 'agent',
      tool_calls: [tc],
    });
  }

  if (steps.length === 0) {
    steps.push({ step_id: 1, source: 'user', message: '' });
  }

  const traj: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: 'kimi', version },
    steps,
  };

  const result = validateTrajectory(traj);
  if (!result.ok) {
    throw new Error(
      `normalizeKimi produced invalid ATIF: ${result.errors.join('; ')}`,
    );
  }

  return traj;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The injection origin of a kimi row: a top-level `origin`, else the message's
// `origin` (parity with Python _kimi_injection_origin).
function kimiInjectionOrigin(row: Record<string, unknown>): unknown {
  const origin = row['origin'];
  if (origin !== undefined && origin !== null) {
    return origin;
  }
  const message = row['message'];
  return isRecord(message) ? message['origin'] : null;
}

// Flatten a kimi message's content (string, or an array of strings / {text}
// parts) into one string (parity with Python _kimi_message_text).
function kimiMessageText(row: Record<string, unknown>): string {
  const message = row['message'];
  if (!isRecord(message)) {
    return '';
  }
  const content = message['content'];
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (isRecord(part) && typeof part['text'] === 'string') {
      parts.push(part['text']);
    }
  }
  return parts.join('\n');
}

/**
 * Whether any kimi wire log proves the Superpowers `plugin_session_start`
 * injection fired (parity with quorum kimi_logs_have_superpowers_session_start).
 * Accepts either a direct `event.type == plugin_session_start` row carrying
 * plugin=superpowers + skill=using-superpowers, OR an injection-origin variant
 * whose message text contains `<plugin_session_start` + superpowers +
 * using-superpowers. Unreadable files and blank/non-JSON/non-object lines are
 * skipped without throwing. This is the core proof Superpowers loaded for a kimi
 * run; its absence flags the capture as indeterminate.
 */
export function kimiLogsHaveSuperpowersSessionStart(
  paths: readonly string[],
): boolean {
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(row)) {
        continue;
      }
      const event = row['event'];
      if (
        isRecord(event) &&
        event['type'] === 'plugin_session_start' &&
        event['plugin'] === 'superpowers' &&
        event['skill'] === 'using-superpowers'
      ) {
        return true;
      }
      const origin = kimiInjectionOrigin(row);
      if (
        !(
          isRecord(origin) &&
          origin['kind'] === 'injection' &&
          origin['variant'] === 'plugin_session_start'
        )
      ) {
        continue;
      }
      const messageText = kimiMessageText(row);
      const lower = messageText.toLowerCase();
      if (
        messageText.includes('<plugin_session_start') &&
        lower.includes('superpowers') &&
        lower.includes('using-superpowers')
      ) {
        return true;
      }
    }
  }
  return false;
}
