/**
 * Per-coding-agent configuration loader.
 *
 * A coding-agent.yaml describes one agent CLI: its binary, where it writes
 * session logs, which normalizer to apply to those logs, and required env
 * vars. Authored once per agent CLI; shared across scenarios.
 *
 * sessionLogDir is a template string that may reference the per-coding-agent
 * config-dir env var (e.g. "${CLAUDE_CONFIG_DIR}/projects"). The runner
 * allocates a fresh dir per run, sets the env var, and substitutes the
 * template — keeping the agent under test isolated from the user's real
 * ~/.claude or ~/.codex. Literal paths still work (the substitution is a
 * no-op if no placeholders are present).
 *
 * Port of quorum/coding_agent_config.py.
 */

import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Normalizer names that have a TS implementation in the unified dispatcher. */
export const SUPPORTED_NORMALIZERS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "gemini",
  "copilot",
  "opencode",
  "pi",
  "kimi",
  "antigravity",
]);

/** Known runtime families — mirrors KNOWN_RUNTIME_FAMILIES in the Python module. */
export const KNOWN_RUNTIME_FAMILIES: ReadonlySet<string> = new Set([
  "antigravity",
  "claude",
  "codex",
  "copilot",
  "gemini",
  "kimi",
  "opencode",
  "pi",
]);

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class CodingAgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodingAgentConfigError";
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface CodingAgentConfig {
  readonly name: string;
  readonly runtimeFamily: string;
  readonly binary: string;
  readonly agentConfigEnv: string;
  /** Template string, e.g. "${CLAUDE_CONFIG_DIR}/projects" */
  readonly sessionLogDir: string;
  readonly sessionLogGlob: string;
  readonly normalizer: string;
  readonly requiredEnv: readonly string[];
  readonly model: string | null;
  readonly maxTime: string | null;
  readonly projectPrompt: string | null;

  /**
   * Substitute the agent-config env var in sessionLogDir and expand leading ~.
   * Returns the resolved absolute path as a string.
   */
  resolveSessionLogDir(agentConfigDir: string): string;
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

class CodingAgentConfigImpl implements CodingAgentConfig {
  constructor(
    public readonly name: string,
    public readonly runtimeFamily: string,
    public readonly binary: string,
    public readonly agentConfigEnv: string,
    public readonly sessionLogDir: string,
    public readonly sessionLogGlob: string,
    public readonly normalizer: string,
    public readonly requiredEnv: readonly string[],
    public readonly model: string | null,
    public readonly maxTime: string | null,
    public readonly projectPrompt: string | null,
  ) {}

  resolveSessionLogDir(agentConfigDir: string): string {
    // Replace ${AGENT_CONFIG_ENV} placeholder with the actual dir path.
    const substituted = this.sessionLogDir.replace(
      `\${${this.agentConfigEnv}}`,
      agentConfigDir,
    );
    // Expand leading ~
    return expandUser(substituted);
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function expandUser(p: string): string {
  if (!p.startsWith("~")) return p;
  const home = process.env["HOME"] ?? "";
  return join(home, p.slice(1));
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Superpowers root defaulting
// ---------------------------------------------------------------------------

/**
 * Infer the parent superpowers checkout for a nested superpowers/evals clone.
 *
 * Only defaults when the checkout is named `evals` and its parent looks like a
 * superpowers checkout (has a `skills/` directory). Returns null for standalone
 * checkouts.
 */
export function defaultSuperpowersRoot(evalRepoRoot: string): string | null {
  const root = resolve(evalRepoRoot);
  const parent = resolve(root, "..");
  if (basename(root) === "evals" && isDirectory(join(parent, "skills"))) {
    return parent;
  }
  return null;
}

/**
 * Set SUPERPOWERS_ROOT for nested checkouts when the caller omitted it.
 */
export function ensureSuperpowersRootDefault(evalRepoRoot?: string): void {
  if (process.env["SUPERPOWERS_ROOT"]) return;

  const root = evalRepoRoot ?? resolve(import.meta.dir, "../../..");
  const def = defaultSuperpowersRoot(root);
  if (def !== null) {
    process.env["SUPERPOWERS_ROOT"] = def;
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS = [
  "name",
  "binary",
  "agent_config_env",
  "session_log_dir",
  "session_log_glob",
  "normalizer",
  "required_env",
] as const;

export function loadCodingAgentConfig(path: string): CodingAgentConfig {
  ensureSuperpowersRootDefault();

  const text = readFileSync(path, "utf-8");
  const raw: unknown = parseYaml(text);

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CodingAgentConfigError(`${path}: top-level must be a mapping`);
  }

  const doc = raw as Record<string, unknown>;

  const missing = REQUIRED_FIELDS.filter((k) => !(k in doc));
  if (missing.length > 0) {
    throw new CodingAgentConfigError(
      `${path}: missing required fields: ${JSON.stringify(missing)}`,
    );
  }

  const name = doc["name"] as string;
  // File stem = basename without extension
  const stem = basename(path).replace(/\.yaml$/, "");
  if (name !== stem) {
    throw new CodingAgentConfigError(
      `${path}: name must match file stem; got name ${JSON.stringify(name)}`,
    );
  }

  const runtimeFamily =
    "runtime_family" in doc ? (doc["runtime_family"] as string) : name;
  if (!KNOWN_RUNTIME_FAMILIES.has(runtimeFamily)) {
    throw new CodingAgentConfigError(
      `${path}: unknown runtime_family ${JSON.stringify(runtimeFamily)}; ` +
        `known: ${JSON.stringify([...KNOWN_RUNTIME_FAMILIES].sort())}`,
    );
  }

  // Model validation
  const modelRaw = "model" in doc ? doc["model"] : undefined;
  if (modelRaw !== undefined && modelRaw !== null && typeof modelRaw !== "string") {
    throw new CodingAgentConfigError(`${path}: model must be a string`);
  }
  const model: string | null = typeof modelRaw === "string" ? modelRaw : null;

  if (runtimeFamily === "claude" && typeof model !== "string") {
    throw new CodingAgentConfigError(
      `${path}: claude runtime_family requires model`,
    );
  }
  if (typeof model === "string" && model.trim() === "") {
    throw new CodingAgentConfigError(`${path}: model must not be blank`);
  }
  if (runtimeFamily !== "claude" && runtimeFamily !== name) {
    throw new CodingAgentConfigError(
      `${path}: non-Claude variants are not supported in v1`,
    );
  }

  // Required env vars
  const requiredEnv = (doc["required_env"] as unknown[]).map(String);
  const missingEnv = requiredEnv.filter((v) => !process.env[v]);
  if (missingEnv.length > 0) {
    throw new CodingAgentConfigError(
      `${path}: required env vars not set: ${JSON.stringify(missingEnv)}`,
    );
  }

  // Normalizer validation
  const normalizer = doc["normalizer"] as string;
  if (!SUPPORTED_NORMALIZERS.has(normalizer)) {
    throw new CodingAgentConfigError(
      `${path}: unknown normalizer ${JSON.stringify(normalizer)}; ` +
        `known: ${JSON.stringify([...SUPPORTED_NORMALIZERS].sort())}`,
    );
  }

  // project_prompt
  let projectPrompt: string | null = null;
  const projectPromptRaw = doc["project_prompt"];
  if (projectPromptRaw) {
    const candidate = resolve(dirname(path), String(projectPromptRaw));
    if (!isFile(candidate)) {
      throw new CodingAgentConfigError(
        `${path}: project_prompt path does not exist: ${candidate}`,
      );
    }
    projectPrompt = candidate;
  }

  return new CodingAgentConfigImpl(
    name,
    runtimeFamily,
    doc["binary"] as string,
    doc["agent_config_env"] as string,
    doc["session_log_dir"] as string,
    doc["session_log_glob"] as string,
    normalizer,
    requiredEnv,
    model,
    ("max_time" in doc && doc["max_time"] != null)
      ? String(doc["max_time"])
      : null,
    projectPrompt,
  );
}
