// Per-job credential scoping (F13 filesystem half): which env-var names and
// bundle OAuth mounts does a job's agent/credential set actually need? The
// appliance container mounts only these, so the agent under test can reach
// only its own credential material by filesystem. The empty shape is an
// ASSERTED zero-material scope; "unscoped/legacy full bundle" exists only as
// an omitted scope at the future container API, which Task 1 does not choose.
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

// Conventional API-key env name per runtime family, mirroring what each
// adapter actually passes resolveApiKey(credential, <conventional>) — or, for
// kimi, the env its api-key path reads directly (KIMI_MODEL_API_KEY; kimi_k3
// omits api_key_env on purpose). Frozen contract: a name here is what the
// appliance bundle must carry for that family's api-key credentials that
// don't declare api_key_env. codex deliberately has NO fallback (its adapter
// calls resolveApiKey(credential, undefined) — an api-key codex credential
// must declare api_key_env); hermes derives a provider-specific key env (its
// corpus credentials all declare api_key_env); copilot/antigravity are OAuth
// paths.
export const CONVENTIONAL_API_KEY_ENV: Readonly<Record<string, string>> = {
  claude: 'ANTHROPIC_API_KEY',
  serf: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  kimi: 'KIMI_MODEL_API_KEY',
  opencode: 'OPENAI_API_KEY',
  pi: 'PI_API_KEY',
};

export interface CredentialScope {
  readonly envNames: readonly string[];
  readonly authMounts: readonly string[];
}

// Own-property credential lookup: inherited Object.prototype members
// ('constructor', '__proto__', 'toString', ...) must never be treated as
// registry entries — `name in registry` and bare `registry[name]` both see
// them (registry['constructor'] is the Object constructor), which historically
// turned a typo'd name into "TypeError: entry.harnesses.includes" instead of
// the named unknown-credential error. Every registry read goes through here so
// refactors cannot reintroduce the inherited-property read.
function lookupCredential(
  registry: Record<string, Credential>,
  name: string,
): Credential | undefined {
  return Object.hasOwn(registry, name) ? registry[name] : undefined;
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

// Fold one compatible agent/credential pair into the scope. For api-key auth
// the env name is credential.api_key_env when declared, else the family's
// conventional adapter name — and when neither exists, fail closed (a
// zero-material scope would silently strand the agent without a key). Other
// auth types contribute api_key_env only when declared (e.g. bedrock-bearer's
// AWS_BEARER_TOKEN_BEDROCK); oauth/subscription additionally contribute the
// agent's bundle mount when the harness has an entry.
function contribute(
  credName: string,
  entry: Pick<Credential, 'api_key_env' | 'auth'>,
  agent: string,
  family: string,
  envNames: Set<string>,
  authMounts: Set<string>,
): void {
  if (entry.auth === 'api-key') {
    const envName = entry.api_key_env ?? CONVENTIONAL_API_KEY_ENV[family];
    if (envName === undefined) {
      throw new Error(
        `credential scope: api-key credential '${credName}' declares no api_key_env and agent '${agent}' (family '${family}') has no conventional api-key env name`,
      );
    }
    envNames.add(envName);
  } else if (entry.api_key_env !== undefined) {
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
 * empty scope. An empty `agents` list returns an asserted zero-material scope
 * (empty arrays); whether the caller treats a supplied empty scope as
 * zero-material or legacy is the future container API's decision, not this
 * function's.
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
      const family = agentRuntimeFamily(
        loadAgentOrThrow(codingAgentsDir, agent),
      );
      const credName = resolveCredentialNameForAgent(
        codingAgentsDir,
        agent,
        undefined,
      );
      if (credName === undefined) continue; // no default: no bundle material
      const entry = lookupCredential(registry, credName);
      if (entry === undefined) {
        throw new Error(
          `credential scope: unknown default credential '${credName}' for agent '${agent}'`,
        );
      }
      contribute(credName, entry, agent, family, envNames, authMounts);
    }
    return {
      envNames: [...envNames].sort(),
      authMounts: [...authMounts].sort(),
    };
  }

  for (const name of credentials) {
    if (lookupCredential(registry, name) === undefined) {
      throw new Error(
        `credential scope: unknown credential '${name}' (available: ${Object.keys(registry).sort().join(', ')})`,
      );
    }
  }

  let pairs = 0;
  for (const agent of agents) {
    const family = agentRuntimeFamily(loadAgentOrThrow(codingAgentsDir, agent));
    for (const name of credentials) {
      const entry = lookupCredential(registry, name);
      if (entry === undefined || !entry.harnesses.includes(family)) continue;
      pairs += 1;
      contribute(name, entry, agent, family, envNames, authMounts);
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
