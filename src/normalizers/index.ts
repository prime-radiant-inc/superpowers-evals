import type { ToolCall } from '../contracts/verdict.ts';
import { normalizeAntigravityLogs } from './antigravity.ts';
import { normalizeClaudeLogs } from './claude.ts';
import { normalizeCodexLogs } from './codex.ts';
import { normalizeCopilotLogs } from './copilot.ts';
import { normalizeGeminiLogs } from './gemini.ts';
import { normalizeKimiLogs } from './kimi.ts';
import { normalizeOpencodeLogs } from './opencode.ts';
import { normalizePiLogs } from './pi.ts';

export type Normalizer = (raw: string) => ToolCall[];

// Backend (coding-agent name) -> normalizer function. Mirrors the NORMALIZERS
// table in quorum/normalizers.py: all eight dialects shipped (Spec 1 claude,
// Spec 2 the rest). Each is replay-verified against the Python oracle.
export const NORMALIZERS: Record<string, Normalizer> = {
  antigravity: normalizeAntigravityLogs,
  claude: normalizeClaudeLogs,
  codex: normalizeCodexLogs,
  copilot: normalizeCopilotLogs,
  gemini: normalizeGeminiLogs,
  kimi: normalizeKimiLogs,
  opencode: normalizeOpencodeLogs,
  pi: normalizePiLogs,
};
