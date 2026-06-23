// Maps each coding-agent to the ambient project-instructions file it reads from
// its workdir — the channel a user CLAUDE.md-style preference rides. Established
// EMPIRICALLY by the canary probe (scenarios/probe-ambient-instruction-file,
// 2026-06-23), NOT from docs: kimi reads AGENTS.md, NOT CLAUDE.md, despite being
// Claude-shaped. Keyed on the coding-agent slug (the runner's a.codingAgent).
//
// Writing a preference into the WRONG file silently false-passes an override
// eval (the preference never loads, so "skill correctly suppressed" is vacuous),
// so an unmapped agent is a HARD ERROR — never a silent no-op. Agents whose
// ambient file is not yet probed (pi/antigravity/opencode) are intentionally
// absent: probe them before injecting preferences for them.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const AGENT_INSTRUCTION_FILES: Readonly<Record<string, string>> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
  kimi: 'AGENTS.md',
};

/** The ambient instructions filename the coding-agent honors. Throws if unmapped. */
export function instructionFileForAgent(agent: string): string {
  const file = AGENT_INSTRUCTION_FILES[agent];
  if (file === undefined) {
    const known = Object.keys(AGENT_INSTRUCTION_FILES).sort().join(', ');
    throw new Error(
      `inject-user-preference: no verified ambient-instructions file for coding-agent '${agent}'; known: ${known}. Probe its ambient file (scenarios/probe-ambient-instruction-file) before injecting preferences for it.`,
    );
  }
  return file;
}

/**
 * Append a user preference to the ambient instructions file `agent` honors,
 * under `workdir`. Appends (never clobbers): the harness may already have seeded
 * an instructions file. Throws for an unmapped agent (via instructionFileForAgent).
 */
export function injectUserPreference(
  workdir: string,
  agent: string,
  text: string,
): void {
  const file = instructionFileForAgent(agent);
  appendFileSync(join(workdir, file), `${text}\n`, 'utf8');
}
