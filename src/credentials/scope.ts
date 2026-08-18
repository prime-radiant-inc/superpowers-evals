// Per-job credential scoping (F13 filesystem half): which env-var names and
// bundle OAuth mounts does a job's agent/credential set actually need? The
// appliance container mounts only these, so the agent under test can reach
// only its own credential material by filesystem. Empty scope = unscoped
// (legacy full-bundle behavior); the container layer fails closed only when a
// scope is asserted.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentConfig,
  agentRuntimeFamily,
  loadAgentConfigForValidation,
} from '../contracts/agent-config.ts';
import type { Credential } from '../contracts/credential.ts';
import { repoRoot } from '../paths.ts';
import { loadCredentialsFile } from './file.ts';
import { resolveCredentialNameForAgent } from './resolve.ts';

// The bundle OAuth mount directory per harness family. Antigravity's auth
// state lives under the gemini mount (~/.gemini/...); harnesses whose auth is
// seeded purely via env vars or run-home files (claude, copilot, opencode,
// serf, hermes) have no entry.
export const AGENT_OAUTH_MOUNT: Readonly<Record<string, string>> = {
  codex: 'codex',
  gemini: 'gemini',
  antigravity: 'gemini',
  kimi: 'kimi',
  pi: 'pi',
};

export interface CredentialScope {
  readonly envNames: readonly string[];
  readonly authMounts: readonly string[];
}

// Load an agent's config or fail with an error naming the agent. A missing
// agent yaml gets a clear message (readAgentConfigFile's raw ENOENT names only
// the path); a structurally invalid one fails via loadAgentConfigForValidation
// (whose CodingAgentConfigError names the yaml path, i.e. the agent).
function loadAgentOrThrow(codingAgentsDir: string, agent: string): AgentConfig {
  if (!existsSync(join(codingAgentsDir, `${agent}.yaml`))) {
    throw new Error(`credential scope: unknown coding agent '${agent}'`);
  }
  return loadAgentConfigForValidation(codingAgentsDir, agent);
}

// Fold one compatible agent/credential pair into the scope: the env var name
// whenever the credential declares one (regardless of auth type), and the
// agent's OAuth mount when auth rides the bundle (oauth/subscription) and the
// harness has a mount entry.
function contribute(
  entry: Pick<Credential, 'api_key_env' | 'auth'>,
  agent: string,
  envNames: Set<string>,
  authMounts: Set<string>,
): void {
  if (entry.api_key_env !== undefined) {
    envNames.add(entry.api_key_env);
  }
  if (entry.auth === 'oauth' || entry.auth === 'subscription') {
    const mount = AGENT_OAUTH_MOUNT[agent];
    if (mount !== undefined) {
      authMounts.add(mount);
    }
  }
}

/**
 * Resolve the credential scope for a job's agent/credential selection.
 *
 * `credentials === null` selects each agent's default credential (via the
 * real resolver); a valid agent with no default contributes no bundle
 * material. `credentials` non-null names an explicit selection (the run-all
 * `--credentials` csv shape): every name is validated, then only pairs whose
 * credential `harnesses` include the agent's runtime family contribute —
 * mirroring run-all matrix eligibility. A nonempty selection with zero
 * compatible pairs throws (fail closed) rather than returning an ambiguous
 * empty scope. An empty `agents` list returns the unscoped (empty) scope.
 */
export function credentialScopeForAgents(
  agents: readonly string[],
  credentials: readonly string[] | null,
): CredentialScope {
  if (agents.length === 0) {
    return { envNames: [], authMounts: [] };
  }

  const root = repoRoot();
  const codingAgentsDir = join(root, 'coding-agents');
  const registry = loadCredentialsFile(
    join(root, 'credentials.yaml'),
  ).credentials;

  const envNames = new Set<string>();
  const authMounts = new Set<string>();

  if (credentials === null) {
    for (const agent of agents) {
      loadAgentOrThrow(codingAgentsDir, agent);
      const credName = resolveCredentialNameForAgent(
        codingAgentsDir,
        agent,
        undefined,
      );
      if (credName === undefined) continue; // no default: no bundle material
      const entry = registry[credName];
      if (entry === undefined) {
        throw new Error(
          `credential scope: unknown default credential '${credName}' for agent '${agent}'`,
        );
      }
      contribute(entry, agent, envNames, authMounts);
    }
    return {
      envNames: [...envNames].sort(),
      authMounts: [...authMounts].sort(),
    };
  }

  for (const name of credentials) {
    if (!(name in registry)) {
      throw new Error(
        `credential scope: unknown credential '${name}' (available: ${Object.keys(registry).sort().join(', ')})`,
      );
    }
  }

  let pairs = 0;
  for (const agent of agents) {
    const family = agentRuntimeFamily(loadAgentOrThrow(codingAgentsDir, agent));
    for (const name of credentials) {
      const entry = registry[name];
      if (entry === undefined || !entry.harnesses.includes(family)) continue;
      pairs += 1;
      contribute(entry, agent, envNames, authMounts);
    }
  }
  if (pairs === 0) {
    throw new Error(
      `credential scope: no credential in [${credentials.join(', ')}] is compatible with agent(s) [${agents.join(', ')}] — refusing to return an ambiguous empty scope`,
    );
  }
  return {
    envNames: [...envNames].sort(),
    authMounts: [...authMounts].sort(),
  };
}
