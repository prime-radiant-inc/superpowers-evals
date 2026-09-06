import { z } from 'zod';

/** Every effort level any supported harness accepts. The per-family table
 *  below says which subset each harness honors; the union is what the arm
 *  and execution-surface schemas admit before family validation runs. */
export const EFFORT_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const EffortLevelSchema = z.enum(EFFORT_LEVELS);

/** Codex: the documented `model_reasoning_effort` config values (Responses
 *  API; xhigh is model-dependent). Claude Code: the documented `--effort` /
 *  CLAUDE_CODE_EFFORT_LEVEL levels (Opus 5, Opus 4.8, Sonnet 5 accept xhigh).
 *  Families absent from this table have no effort control and refuse every
 *  level rather than silently ignoring it. */
export const EFFORT_LEVELS_BY_FAMILY: Readonly<
  Record<string, readonly EffortLevel[]>
> = {
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
};

/** null when `family` honors `level`; otherwise the reason it is refused. */
export function effortRefusal(family: string, level: string): string | null {
  const supported = EFFORT_LEVELS_BY_FAMILY[family];
  if (supported === undefined) {
    return `harness ${family} has no effort control`;
  }
  if (!(supported as readonly string[]).includes(level)) {
    return `harness ${family} does not accept effort ${level} (accepts ${supported.join(', ')})`;
  }
  return null;
}
