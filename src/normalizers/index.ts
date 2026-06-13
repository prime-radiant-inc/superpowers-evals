import type { ToolCall } from '../contracts/verdict.ts';
import { normalizeClaudeLogs } from './claude.ts';
import { normalizeCodexLogs } from './codex.ts';

export type Normalizer = (raw: string) => ToolCall[];

/**
 * Backend (normalizer name) -> normalizer function. Spec 1 ships claude only;
 * Spec 2 fans out the remaining dialects (codex, copilot, gemini, kimi,
 * opencode, pi).
 */
export const NORMALIZERS: Record<string, Normalizer> = {
  claude: normalizeClaudeLogs,
  codex: normalizeCodexLogs,
};
