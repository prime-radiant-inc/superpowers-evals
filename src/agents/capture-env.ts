import { getEnv } from '../env.ts';

// Shared non-secret base env for LOCAL session-capture subprocesses (opencode
// `session list`/`export`, hermes `sessions list`/`export`). These children
// read run-local session state only — no network, no provider auth — so they
// receive NO credential: everything they resolve comes from the run-local
// HOME/XDG (+ per-tool config-dir) pins their caller overlays on this base.
//
// The base is the exact set with active-path evidence:
//   PATH — structural: the child resolves its bare binary name through the
//     child env's PATH (same evidence as the provisioning allowlist).
//   TERM/LANG — the CLI-output base pair every quorum child gets; both
//     default below (as the launchers' base trio does) so a bare host env
//     still yields a working child.
// Everything else — provider/AWS bundles, proxies, CA bundles, locale extras —
// has no consumer on the local capture path and is deliberately absent. A
// future need fails the capture loudly (a capture error surfaces in the
// verdict) and is added here with evidence; a leaked var is silent.
export const CAPTURE_ENV_ALLOWLIST: readonly string[] = ['PATH', 'TERM', 'LANG'];

// Project the host env onto CAPTURE_ENV_ALLOWLIST with the standard fallbacks
// (PATH falls back to the POSIX default "/bin:/usr/bin").
export function captureBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CAPTURE_ENV_ALLOWLIST) {
    const value = getEnv(name);
    if (value !== undefined) env[name] = value;
  }
  if (!('PATH' in env)) env['PATH'] = '/bin:/usr/bin';
  if (!('TERM' in env)) env['TERM'] = 'xterm-256color';
  if (!('LANG' in env)) env['LANG'] = 'C.UTF-8';
  return env;
}
