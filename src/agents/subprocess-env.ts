import { getEnv } from '../env.ts';

// Base non-secret allowlist for adapter provisioning subprocesses (agent CLIs
// running plugin installs / auth preflights / syntax checks). These CLIs are
// third-party code with host reach; the full provider bundle has no business
// in their environment. Caller extras overlay the base. Fail-loud rule: a
// missing var breaks the subprocess loudly and is added on evidence; a
// leaked var is silent.
//
// Corpus-governed (F13 Task 2 scan, 2026-08-18; method + counts in the task
// report): every name below has a direct read in at least one of the five
// provisioning CLIs' distributions — agy (binary strings), gemini-cli
// (bundle process.env reads), hermes (venv source os.environ), gh (binary
// strings), node (documented env vars):
//   PATH/TERM/LANG/LC_ALL/LC_CTYPE/HOME/TMPDIR/SHELL/USER/TZ/CI — agy + gh;
//   LOGNAME — hermes_cli/auth.py;
//   HTTP(S)_PROXY/NO_PROXY/http(s)_proxy/no_proxy — gemini-cli + agy;
//   ALL_PROXY/all_proxy — hermes;
//   SSL_CERT_FILE/SSL_CERT_DIR/REQUESTS_CA_BUNDLE/CURL_CA_BUNDLE —
//     hermes agent/ssl_verify.py (TLS bundle resolution);
//   NODE_EXTRA_CA_CERTS — documented node var (opencode binary strings);
//   XDG_CONFIG_HOME — agy + gh; XDG_CACHE_HOME/XDG_STATE_HOME — hermes_cli;
//   XDG_DATA_HOME — opencode binary strings.
// Credential-shaped names (GEMINI_API_KEY, GOOGLE_API_KEY, GH_TOKEN, …) are
// read by some of these CLIs but are deliberately absent: provisioning
// delivers credentials via per-run files (gemini .gemini-env, hermes .env,
// copilot .copilot-env) or the OS keyring, never via the host env.
export const PROVISION_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'HOME',
  'TMPDIR',
  'SHELL',
  'USER',
  'LOGNAME',
  'TZ',
  'CI',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
];

/**
 * Project the host env onto {@link PROVISION_ENV_ALLOWLIST}, then overlay
 * `extra` (adapter-specific vars like GEMINI_CLI_HOME / HERMES_HOME, which
 * win over any base name). Undefined host values are omitted, never passed
 * through as empty strings.
 */
export function provisionSubprocessEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PROVISION_ENV_ALLOWLIST) {
    const value = getEnv(name);
    if (value !== undefined) out[name] = value;
  }
  return { ...out, ...extra };
}
