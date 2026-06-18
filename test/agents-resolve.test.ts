import { expect, test } from 'bun:test';
import { AntigravityAgent } from '../src/agents/antigravity.ts';
import { CodexAgent } from '../src/agents/codex.ts';
import { CopilotAgent } from '../src/agents/copilot.ts';
import { GeminiAgent } from '../src/agents/gemini.ts';
import { resolveAgent } from '../src/agents/index.ts';
import { KimiAgent } from '../src/agents/kimi.ts';
import { OpenCodeAgent } from '../src/agents/opencode.ts';
import { PiAgent } from '../src/agents/pi.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';

// Minimal config; only name/runtime_family drive dispatch.
function cfg(name: string, runtimeFamily?: string): AgentConfig {
  return {
    name,
    binary: name,
    home_config_subdir: '.',
    session_log_dir: '${QUORUM_AGENT_HOME}',
    session_log_glob: '*.jsonl',
    normalizer: name,
    required_env: [],
    os_support: ['linux'],
    max_time: '10m',
    max_concurrency: 1,
    ...(runtimeFamily === undefined ? {} : { runtime_family: runtimeFamily }),
  };
}

test('resolveAgent dispatches each dialect name to its custom adapter', () => {
  expect(resolveAgent(cfg('codex'))).toBeInstanceOf(CodexAgent);
  expect(resolveAgent(cfg('gemini'))).toBeInstanceOf(GeminiAgent);
  expect(resolveAgent(cfg('pi'))).toBeInstanceOf(PiAgent);
  expect(resolveAgent(cfg('copilot'))).toBeInstanceOf(CopilotAgent);
  expect(resolveAgent(cfg('opencode'))).toBeInstanceOf(OpenCodeAgent);
  expect(resolveAgent(cfg('kimi'))).toBeInstanceOf(KimiAgent);
  expect(resolveAgent(cfg('antigravity'))).toBeInstanceOf(AntigravityAgent);
});

test('resolveAgent maps the claude runtime family to ClaudeAgent', () => {
  // claude-haiku/claude-sonnet carry runtime_family=claude; the bare name works too.
  const haiku = resolveAgent(cfg('claude-haiku', 'claude'));
  const claude = resolveAgent(cfg('claude'));
  expect(haiku.config.name).toBe('claude-haiku');
  expect(claude.config.name).toBe('claude');
});

test('resolveAgent falls back to the declarative default for unknown names', () => {
  const agent = resolveAgent(cfg('some-future-agent'));
  // Not one of the custom adapters.
  expect(agent).not.toBeInstanceOf(CodexAgent);
  expect(agent.config.name).toBe('some-future-agent');
});
