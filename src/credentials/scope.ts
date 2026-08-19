// Per-job credential scoping (F13 filesystem half): resolve exactly ONE
// agent/credential selection into the closed delivery contract the appliance
// container enforces — which env names cross into the job (agentEnv) and which
// bundle OAuth mount it receives (oauth). The empty shape is an ASSERTED
// zero-material scope; "unscoped/legacy full bundle" exists only as an omitted
// scope at the future container API, which this module never chooses.
// Persisted OAuth kinds are literals, never record-controlled source paths.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentConfig,
  agentRuntimeFamily,
  loadAgentConfigForValidation,
} from '../contracts/agent-config.ts';
import type { Credential } from '../contracts/credential.ts';
import { loadCredentialsFile } from './file.ts';

export interface CredentialSelection {
  readonly agent: string;
  readonly credential: string | null;
}

export interface AgentEnvProjection {
  readonly destinationName: string;
  readonly sourceNames: readonly string[];
}

export type OAuthProjection =
  | { readonly kind: 'codex'; readonly mountName: 'codex' }
  | { readonly kind: 'gemini'; readonly mountName: 'gemini' }
  | { readonly kind: 'antigravity'; readonly mountName: 'gemini' }
  | { readonly kind: 'kimi'; readonly mountName: 'kimi' }
  | {
      readonly kind: 'pi';
      readonly mountName: 'pi';
      readonly provider: string;
    };

export interface EmptyCredentialScope {
  readonly schemaVersion: 1;
  readonly kind: 'empty';
  readonly agent: null;
  readonly runtimeFamily: null;
  readonly credential: null;
  readonly agentEnv: readonly [];
  readonly geminiAuthType: null;
  readonly oauth: null;
}

export interface LiveCredentialScope {
  readonly schemaVersion: 1;
  readonly kind: 'live';
  readonly agent: string;
  readonly runtimeFamily: string;
  readonly credential: string;
  readonly agentEnv: readonly AgentEnvProjection[];
  readonly geminiAuthType: 'gemini-api-key' | 'oauth-personal' | null;
  readonly oauth: OAuthProjection | null;
}

export type CredentialScope = EmptyCredentialScope | LiveCredentialScope;

export const EMPTY_CREDENTIAL_SCOPE: EmptyCredentialScope = {
  schemaVersion: 1,
  kind: 'empty',
  agent: null,
  runtimeFamily: null,
  credential: null,
  agentEnv: [],
  geminiAuthType: null,
  oauth: null,
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
// paths. Mantle (bedrock-bearer) never uses this map.
export const CONVENTIONAL_API_KEY_ENV: Readonly<Record<string, string>> = {
  claude: 'ANTHROPIC_API_KEY',
  serf: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  kimi: 'KIMI_MODEL_API_KEY',
  opencode: 'OPENAI_API_KEY',
  pi: 'PI_API_KEY',
};

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

// What one audited (family, auth) channel delivers into the job.
interface Delivery {
  readonly agentEnv: readonly AgentEnvProjection[];
  readonly geminiAuthType: LiveCredentialScope['geminiAuthType'];
  readonly oauth: OAuthProjection | null;
}

type DeliveryProjector = (
  credName: string,
  credential: Credential,
  family: string,
) => Delivery;

function passthroughEnv(name: string): readonly AgentEnvProjection[] {
  return [{ destinationName: name, sourceNames: [name] }];
}

function mountOnly(oauth: OAuthProjection): Delivery {
  return { agentEnv: [], geminiAuthType: null, oauth };
}

// api-key: explicit api_key_env, else the family's reviewed conventional
// destination; when neither exists, fail closed (a zero-material scope would
// silently strand the agent without a key).
const apiKey: DeliveryProjector = (credName, credential, family) => {
  const envName = credential.api_key_env ?? CONVENTIONAL_API_KEY_ENV[family];
  if (envName === undefined) {
    throw new Error(
      `credential scope: api-key credential '${credName}' declares no api_key_env and family '${family}' has no conventional api-key env name`,
    );
  }
  return {
    agentEnv: passthroughEnv(envName),
    geminiAuthType: null,
    oauth: null,
  };
};

// Claude Mantle: the bearer env is required on the record — no conventional
// fallback. CLAUDE_CODE_USE_MANTLE and AWS_REGION are derived by the claude
// adapter from the credential record itself, never read from the bundle env,
// so the scope carries only the bearer.
const mantle: DeliveryProjector = (credName, credential) => {
  if (credential.api_key_env === undefined) {
    throw new Error(
      `credential scope: bedrock-bearer credential '${credName}' must declare api_key_env`,
    );
  }
  return {
    agentEnv: passthroughEnv(credential.api_key_env),
    geminiAuthType: null,
    oauth: null,
  };
};

const claudeOAuth: DeliveryProjector = () => ({
  agentEnv: passthroughEnv('CLAUDE_CODE_OAUTH_TOKEN'),
  geminiAuthType: null,
  oauth: null,
});

// Copilot resolves its GitHub token from ordered sources into one destination
// (mirrors resolveCopilotAuthEnv in src/agents/copilot.ts).
const copilotOAuth: DeliveryProjector = () => ({
  agentEnv: [
    {
      destinationName: 'COPILOT_GITHUB_TOKEN',
      sourceNames: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
    },
  ],
  geminiAuthType: null,
  oauth: null,
});

const piOAuth: DeliveryProjector = (credName, credential) => {
  if (credential.provider === undefined) {
    throw new Error(
      `credential scope: pi oauth credential '${credName}' must declare provider`,
    );
  }
  return mountOnly({
    kind: 'pi',
    mountName: 'pi',
    provider: credential.provider,
  });
};

// Gemini's mode is derived from credential.auth, never from the ambient
// GEMINI_AUTH_TYPE env var.
const geminiApiKey: DeliveryProjector = (credName, credential, family) => ({
  ...apiKey(credName, credential, family),
  geminiAuthType: 'gemini-api-key',
});

const geminiOAuth: DeliveryProjector = () => ({
  agentEnv: [],
  geminiAuthType: 'oauth-personal',
  oauth: { kind: 'gemini', mountName: 'gemini' },
});

// The audited delivery channels, keyed on runtime family (not the configured
// agent alias) then credential auth. A (family, auth) pair absent here has no
// audited channel and fails closed. Antigravity's auth state lives under the
// gemini mount (~/.gemini/...) but keeps its own kind literal.
const DELIVERY_BY_FAMILY: Readonly<
  Record<string, Partial<Record<Credential['auth'], DeliveryProjector>>>
> = {
  antigravity: {
    oauth: () => mountOnly({ kind: 'antigravity', mountName: 'gemini' }),
  },
  claude: { 'api-key': apiKey, 'bedrock-bearer': mantle, oauth: claudeOAuth },
  codex: {
    'api-key': apiKey,
    subscription: () => mountOnly({ kind: 'codex', mountName: 'codex' }),
  },
  copilot: { oauth: copilotOAuth },
  gemini: { 'api-key': geminiApiKey, oauth: geminiOAuth },
  hermes: { 'api-key': apiKey },
  kimi: {
    'api-key': apiKey,
    oauth: () => mountOnly({ kind: 'kimi', mountName: 'kimi' }),
  },
  opencode: { 'api-key': apiKey },
  pi: { 'api-key': apiKey, oauth: piOAuth },
  serf: { 'api-key': apiKey },
};

/**
 * Resolve exactly one agent/credential selection into its live delivery
 * scope, reading the corpus under `evalsRoot` (coding-agents/ +
 * credentials.yaml). `selection.credential === null` resolves the agent's
 * default_credential and persists the concrete name. Every failure — unknown
 * agent or credential, missing default, incompatible pair, missing pi
 * provider, or a (family, auth) pair without an audited delivery channel —
 * throws a named credential-scope error; this function never returns an
 * empty or ambiguous scope.
 */
export function credentialScopeForSelection(
  evalsRoot: string,
  selection: CredentialSelection,
): LiveCredentialScope {
  const codingAgentsDir = join(evalsRoot, 'coding-agents');
  const agentCfg = loadAgentOrThrow(codingAgentsDir, selection.agent);
  const family = agentRuntimeFamily(agentCfg);

  const credName = selection.credential ?? agentCfg.default_credential;
  if (credName === undefined) {
    throw new Error(
      `credential scope: agent '${selection.agent}' declares no default_credential and the selection names no credential`,
    );
  }

  const registry = loadCredentialsFile(
    join(evalsRoot, 'credentials.yaml'),
  ).credentials;
  const credential = lookupCredential(registry, credName);
  if (credential === undefined) {
    throw new Error(
      `credential scope: unknown credential '${credName}' (available: ${Object.keys(registry).sort().join(', ')})`,
    );
  }
  if (!credential.harnesses.includes(family)) {
    throw new Error(
      `credential scope: credential '${credName}' (harnesses: ${credential.harnesses.join(', ')}) is not compatible with agent '${selection.agent}' (family '${family}')`,
    );
  }

  const deliver = DELIVERY_BY_FAMILY[family]?.[credential.auth];
  if (deliver === undefined) {
    throw new Error(
      `credential scope: no audited delivery channel for family '${family}' auth '${credential.auth}' (credential '${credName}')`,
    );
  }
  const delivery = deliver(credName, credential, family);
  return {
    schemaVersion: 1,
    kind: 'live',
    agent: selection.agent,
    runtimeFamily: family,
    credential: credName,
    agentEnv: delivery.agentEnv,
    geminiAuthType: delivery.geminiAuthType,
    oauth: delivery.oauth,
  };
}
