// The grader credential source contract shared by the appliance supervisor
// emitter (src/appliance/credential-scope.ts) and the runner's gauntlet child
// projection (src/runner/gauntlet-env.ts). In `appliance-scoped` mode the
// grader credential travels ONLY under the QUORUM_GRADER_* alias names — the
// canonical names never appear in any host-side file or supervisor env — and
// the runner maps each present alias back onto the single canonical name the
// gauntlet CLI reads. Keeping the map here (not in either consumer) is what
// stops the two sides from drifting.

// Canonical gauntlet-side name -> supervisor-side alias. The three auth names
// are exactly what gauntlet's Anthropic auth resolution reads
// (CLAUDE_CODE_OAUTH_TOKEN || ANTHROPIC_AUTH_TOKEN, else ANTHROPIC_API_KEY);
// ANTHROPIC_BASE_URL is the SDK endpoint override that must ride along with
// the key so a gateway-pinned grader fails loudly instead of silently
// re-routing.
export const GRADER_SOURCE_ENV_BY_RUNTIME_NAME = {
  CLAUDE_CODE_OAUTH_TOKEN: 'QUORUM_GRADER_CLAUDE_CODE_OAUTH_TOKEN',
  ANTHROPIC_AUTH_TOKEN: 'QUORUM_GRADER_ANTHROPIC_AUTH_TOKEN',
  ANTHROPIC_API_KEY: 'QUORUM_GRADER_ANTHROPIC_API_KEY',
  ANTHROPIC_BASE_URL: 'QUORUM_GRADER_ANTHROPIC_BASE_URL',
} as const;

export type GraderRuntimeName = keyof typeof GRADER_SOURCE_ENV_BY_RUNTIME_NAME;

// The subset of runtime names that count as AUTH: a base URL alone cannot
// authenticate the grader, so at least one of these must arrive nonempty.
export const GRADER_AUTH_RUNTIME_NAMES = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
] as const satisfies readonly GraderRuntimeName[];

export const QUORUM_GRADER_SOURCE_MODE = 'QUORUM_GRADER_SOURCE_MODE';
export const APPLIANCE_SCOPED_GRADER_MODE = 'appliance-scoped';

// Network/TLS names the supervisor env may carry when the trusted bundle
// defines them: the grader's network layer is Bun fetch, which honors exactly
// these proxy and CA-bundle names (evidence in src/runner/gauntlet-env.ts).
export const SUPERVISOR_NETWORK_ENV_NAMES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;

// Copilot's evidenced routing names — included in the supervisor env only for
// a Copilot scope, and appended to the gauntlet child env only by copilot's
// own projection (src/agents/copilot.ts). Every name is forwarded into the
// copilot binary by the launcher's env -i forward list
// (coding-agents/copilot-context/launch-agent).
export const COPILOT_SUPERVISOR_ENV_NAMES = [
  'GH_HOST',
  'COPILOT_GH_HOST',
  'COPILOT_MODEL',
  'COPILOT_OFFLINE',
  'ALL_PROXY',
  'all_proxy',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const;
