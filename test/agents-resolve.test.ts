import { expect, test } from 'bun:test';
import { AntigravityAgent } from '../src/agents/antigravity.ts';
import { WindowsClaudeAgent } from '../src/agents/claude-windows.ts';
import { CodexAgent } from '../src/agents/codex.ts';
import { CopilotAgent } from '../src/agents/copilot.ts';
import { GeminiAgent } from '../src/agents/gemini.ts';
import { ProvisionError, resolveAgent } from '../src/agents/index.ts';
import { KimiAgent } from '../src/agents/kimi.ts';
import { OpenCodeAgent } from '../src/agents/opencode.ts';
import { PiAgent } from '../src/agents/pi.ts';
import { SerfAgent } from '../src/agents/serf.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import type { OsTarget } from '../src/contracts/os-target.ts';

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
  expect(resolveAgent(cfg('serf'))).toBeInstanceOf(SerfAgent);
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

// --- os-arg dispatch (Task 5) ---

const windowsOsTarget: OsTarget = {
  name: 'windows',
  remote: {
    host: '127.0.0.1',
    port: 2222,
    user: 'user',
    password_env: 'WIN_EVAL_PASSWORD',
    win_run_root: 'C:\\eval-runs',
  },
};

test('resolveAgent(claudeCfg) with no os → ClaudeAgent (linux default)', () => {
  const agent = resolveAgent(cfg('claude'));
  // Not a WindowsClaudeAgent — the linux path applies.
  expect(agent).not.toBeInstanceOf(WindowsClaudeAgent);
  expect(agent.config.name).toBe('claude');
});

test('resolveAgent(claudeCfg, "windows", osTarget) → WindowsClaudeAgent', () => {
  const agent = resolveAgent(cfg('claude'), 'windows', windowsOsTarget);
  expect(agent).toBeInstanceOf(WindowsClaudeAgent);
  expect(agent.config.name).toBe('claude');
});

test('resolveAgent(codexCfg, "windows", osTarget) → throws ProvisionError', () => {
  expect(() => resolveAgent(cfg('codex'), 'windows', windowsOsTarget)).toThrow(
    ProvisionError,
  );
  expect(() => resolveAgent(cfg('codex'), 'windows', windowsOsTarget)).toThrow(
    /no windows provisioner/,
  );
});
