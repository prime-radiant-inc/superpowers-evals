import { getEnv } from '../env.ts';

// Base non-secret allowlist for adapter provisioning subprocesses (agent CLIs
// running plugin installs / auth preflights / syntax checks, plus the
// WindowsHost sshpass/ssh/scp path). These CLIs are third-party code with host
// reach; the full provider bundle has no business in their environment. Caller
// extras overlay the base. Fail-loud rule: a missing var breaks the subprocess
// loudly and is re-added only with active-command evidence; a leaked var is
// silent.
//
// This list is the EXACT union of names with per-name evidence on the active
// path of an in-scope command (Fix Round 1 audit, 2026-08-18, macOS arm64
// host, as corrected in Fix Round 2; method + raw observations in
// task-2-report.md). In-scope commands: C1
// `agy --gemini_dir=… plugin install SRC`, C2 `agy --gemini_dir=… --print`
// (network preflight), C3 `gemini extensions link SRC --consent`, C4
// `gemini extensions list`, C5 `hermes plugins enable superpowers`, C6
// `node --check FILE`, C7 `gh auth token`, C8/C9 `sshpass -p … ssh/scp`.
//
//   PATH — structural: spawnSync resolves the bare binary name through the
//     CHILD env's PATH (verified: a child-env-only PATH resolves the binary;
//     an env without PATH is ENOENT), so every bare-name spawn needs it; plus
//     sshpass execvp()s `ssh` via the child PATH (documented sshpass source).
//   HOME — C2 runtime matrix: unset → keyring silent auth OK (passwd-home
//     fallback), real home → OK, bogus home → "authentication failed"; and C7
//     runtime: HOME routing a fake ~/.config/gh/hosts.yml made gh use the
//     fake token (401 validating it).
//   HTTP_PROXY/http_proxy … (all six) — C2 runtime: a dead HTTPS_PROXY made
//     the preflight dial 127.0.0.1:9 ("proxyconnect tcp"), proving Go's
//     x/net/http/httpproxy FromEnvironment resolver runs on the preflight's
//     network path; its documented read set is exactly HTTP_PROXY/http_proxy,
//     HTTPS_PROXY/https_proxy, NO_PROXY/no_proxy.
//   GH_HOST — C7 runtime: GH_HOST=git.example.com → "no oauth token found for
//     git.example.com" (actively routes host selection).
//   GH_CONFIG_DIR — C7 runtime: pointing it at a dir with no config yields
//     "not logged into any GitHub hosts" (actively routes config resolution;
//     the keychain is not consulted once redirected).
//   XDG_CONFIG_HOME — C7 runtime: a fake $XDG_CONFIG_HOME/gh/hosts.yml was
//     read and its fake token validated against the API (401 Bad credentials).
//
// Deliberately absent (audited out in Fix Round 1 — every in-scope command ran
// successfully under `env -i` without them, or their only citation was an
// unrelated distribution-wide hit): TERM, LANG, LC_ALL, LC_CTYPE, TMPDIR,
// SHELL, USER, LOGNAME, TZ, CI, ALL_PROXY, all_proxy, NODE_EXTRA_CA_CERTS,
// REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE, XDG_CACHE_HOME, XDG_DATA_HOME,
// XDG_STATE_HOME. Also absent (removed in Fix Round 2): SSL_CERT_FILE and
// SSL_CERT_DIR — the Fix Round 1 probe set BOTH to bogus values in a single
// C2 run, proving only that at least one of the pair affects the preflight's
// TLS POST, which does not independently justify either name; under the
// fail-loud rule a custom-CA host fails loudly and re-adds only the
// demonstrated name with per-name evidence. Credential-shaped names
// (GEMINI_API_KEY, GH_TOKEN, …) stay
// out by design: provisioning delivers credentials via per-run 0600 files or
// the OS keyring, never the host env. The exact-list regression in
// test/agent-subprocess-env.test.ts freezes this set; a name may only be
// added together with fresh active-command evidence.
export const PROVISION_ENV_ALLOWLIST: readonly string[] = [
  'GH_CONFIG_DIR',
  'GH_HOST',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'PATH',
  'XDG_CONFIG_HOME',
  'http_proxy',
  'https_proxy',
  'no_proxy',
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
