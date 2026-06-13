/**
 * Unified ATIF normalizer CLI.
 *
 * Usage:
 *   bun run normalize.ts <normalizer-name> <session.jsonl> [--version <v>]
 *
 * Dispatches to the correct normalize<Agent> function based on the
 * normalizer name, prints the ATIF JSON to stdout, and exits 2 on bad args.
 * Mirrors normalize-claude.ts I/O exactly.
 */

import { normalizeClaudeLegacy } from "../normalize/claude.ts";
import { normalizeCodex } from "../normalize/codex.ts";
import { normalizeGemini } from "../normalize/gemini.ts";
import { normalizeCopilot } from "../normalize/copilot.ts";
import { normalizeOpencode } from "../normalize/opencode.ts";
import { normalizePi } from "../normalize/pi.ts";
import { normalizeKimi } from "../normalize/kimi.ts";
import { normalizeAntigravity } from "../normalize/antigravity.ts";
import type { AtifTrajectory } from "../atif/types.ts";

type NormalizeFn = (raw: string, version: string) => AtifTrajectory;

// Maps every normalizer name used in coding-agents/*.yaml to its normalize
// function. All eight coding agents are TS-backed.
const NORMALIZERS: Record<string, NormalizeFn> = {
  claude: normalizeClaudeLegacy,
  codex: normalizeCodex,
  gemini: normalizeGemini,
  copilot: normalizeCopilot,
  opencode: normalizeOpencode,
  pi: normalizePi,
  kimi: normalizeKimi,
  antigravity: normalizeAntigravity,
};

function arg(flag: string, fallback: string): string {
  const i = Bun.argv.indexOf(flag);
  return i >= 0 && Bun.argv[i + 1] ? Bun.argv[i + 1]! : fallback;
}

// argv: [bun, normalize.ts, <normalizer>, <path>, ...flags]
const normalizerName = Bun.argv[2];
const path = Bun.argv[3];

if (!normalizerName || normalizerName.startsWith("--") || !path || path.startsWith("--")) {
  console.error(
    "usage: bun run normalize.ts <normalizer-name> <session.jsonl> [--version <v>]",
  );
  process.exit(2);
}

const normalize = NORMALIZERS[normalizerName];
if (!normalize) {
  console.error(
    `unknown normalizer: ${normalizerName}. Known: ${Object.keys(NORMALIZERS).join(", ")}`,
  );
  process.exit(2);
}

const raw = await Bun.file(path).text();
const traj = normalize(raw, arg("--version", "unknown"));
console.log(JSON.stringify(traj, null, 2));
