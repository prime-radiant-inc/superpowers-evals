// The gauntlet child is quorum's own QA driver, but the agent under test
// shares its UID — and a same-UID process can read a peer's environment
// (/proc/<pid>/environ on Linux, `ps eww` on macOS). The child therefore gets
// an allowlist projection of the host env, never the full snapshot. The
// adapter-curated extraEnv passthrough (launch substitutions like
// KIMI_ENV_FILE; claude-windows' SSH values by design) is applied by
// spawnGauntlet after this base and is unaffected, as are the runner's
// explicit QUORUM_AGENT_CWD / QUORUM_AGENT_HOME overlays.
//
// KNOWN RESIDUAL (owned by the F13 filesystem follow-up plan): the grader
// credential itself (ANTHROPIC_API_KEY et al.) remains readable by a same-UID
// agent via /proc — closing that needs UID separation in the container, not
// env scoping. This list bounds the blast to the grader credential instead of
// the whole provider bundle.
//
// This list is the EXACT union of names with per-name evidence on the gauntlet
// child's active path (`gauntlet run … --adapter tui` under Bun; audit method
// + raw observations in task-5-report.md). Fail-loud rule: a missing var
// breaks the grader loudly (auth/network error) and is re-added only with
// fresh evidence; a leaked var is silent.
//
//   PATH/HOME/USER/SHELL/LANG/LC_ALL/TERM/TMPDIR/TZ — the nine names
//     gauntlet's own bash tool forwards to its inspection commands (gauntlet
//     src/agent/bash-tool.ts BASE_ENV_KEYS); PATH additionally resolves the
//     gauntlet/tmux/bash spawns, and PATH/TERM/LANG feed the launchers'
//     host-fallback forwards inside the tmux pane.
//   HTTP_PROXY/HTTPS_PROXY/NO_PROXY + lowercase — the grader's network layer
//     is Bun fetch, which honors exactly these six names (hermetic localhost
//     probe, Bun 1.3.14); the uppercase trio is also gauntlet's own bash-tool
//     SDK passthrough set.
//   SSL_CERT_FILE/SSL_CERT_DIR/NODE_EXTRA_CA_CERTS — the three CA-bundle
//     names Bun fetch honors (hermetic self-signed-server probe with a
//     rejected control).
//   TMUX_TMPDIR — the TUI adapter's private `-L` tmux server and quorum's own
//     socket-dir resolution (src/agents/agy-teardown.ts) must agree on where
//     tmux sockets live.
//
// Deliberately absent (audited out; evidence in task-5-report.md): LC_CTYPE,
// LOGNAME, CI, NO_COLOR (read only for gauntlet's own stdout stream
// formatting, which the runner drains and discards), ALL_PROXY/all_proxy (not
// honored by Bun fetch), REQUESTS_CA_BUNDLE/CURL_CA_BUNDLE (no consumer on
// the child's active path — gauntlet's bash tool scrubs them from inspection
// commands), GAUNTLET_ROOT (read only by the host-side scripts/evals-container
// wrapper, never by the gauntlet CLI), ANTHROPIC_LOG and GAUNTLET_DEBUG
// (debug-only knobs). Coding-agent provider bundle names (OPENAI_API_KEY,
// GEMINI_API_KEY, AWS_BEARER_TOKEN_BEDROCK, …) stay out by design:
// the agent's credential travels via its per-run 0600 env file, never the
// gauntlet child env.
export const GAUNTLET_ENV_ALLOWLIST: readonly string[] = [
  // base system
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TZ',
  // network proxies
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // TLS trust
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  // tmux (the gauntlet TUI adapter drives the agent through a private server)
  'TMUX_TMPDIR',
  // The grader/driver model credential — the ONLY secrets the child may see:
  // exactly the names gauntlet's Anthropic auth resolution reads (gauntlet
  // src/models/anthropic.ts resolveAnthropicAuth: CLAUDE_CODE_OAUTH_TOKEN ||
  // ANTHROPIC_AUTH_TOKEN, else ANTHROPIC_API_KEY) plus the SDK's endpoint
  // override (@anthropic-ai/sdk client constructor reads ANTHROPIC_BASE_URL).
  // ANTHROPIC_BASE_URL must ride along with the key: dropping it would
  // silently re-route a gateway-pinned grader to the default endpoint instead
  // of failing loudly.
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
];

/**
 * Project the host env onto {@link GAUNTLET_ENV_ALLOWLIST}. Undefined host
 * values are omitted, never passed through as empty strings. Copilot does not
 * use this: it keeps its stricter copilotGauntletEnv (smaller list plus
 * credentialed-proxy rejection).
 */
export function gauntletEnvBase(
  host: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of GAUNTLET_ENV_ALLOWLIST) {
    const value = host[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}
