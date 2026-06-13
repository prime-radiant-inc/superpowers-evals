import { normalizeClaudeLegacy } from "../normalize/claude.ts";

function arg(flag: string, fallback: string): string {
  const i = Bun.argv.indexOf(flag);
  return i >= 0 && Bun.argv[i + 1] ? Bun.argv[i + 1]! : fallback;
}

const path = Bun.argv[2];
if (!path || path.startsWith("--")) {
  console.error("usage: bun run normalize-claude.ts <session.jsonl> [--version <v>]");
  process.exit(2);
}

const raw = await Bun.file(path).text();
const traj = normalizeClaudeLegacy(raw, arg("--version", "unknown"));
console.log(JSON.stringify(traj, null, 2));
