/**
 * Scaffold and validate scenario directories.
 *
 * `newScenario` stamps a structurally-valid scenario skeleton (story.md,
 * setup.sh, checks.sh) with the executable bit set on setup.sh.
 * `checkScenario` validates an existing scenario — checks.sh must exist,
 * parse, define pre() and post(), and be functions-only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as yamlParse } from "yaml";

// ---------------------------------------------------------------------------
// Templates (ported verbatim from quorum/scaffold.py)
// ---------------------------------------------------------------------------

const _STORY_TEMPLATE = `\
---
id: {name}
title: TODO one-line title
status: draft
quorum_tier: full
tags: TODO
---

TODO: brief the QA agent — what it is role-playing, the exact message
it should send the agent under test, and when it is done.

## Acceptance Criteria

- TODO: what must be true after the run. Make criteria evidence-demanding
  (e.g. "a Skill invocation naming superpowers:X appears in the agent's
  session log").
`;

const _SETUP_TEMPLATE = `\
#!/usr/bin/env bash
set -euo pipefail
uv run setup-helpers run create_base_repo
`;

const _CHECKS_TEMPLATE = `\
# Deterministic checks for this scenario. Run by quorum.
# pre() runs after setup.sh, before the Coding-Agent.
# post() runs after the Coding-Agent's run is captured.

pre() {
    git-repo
    git-branch main
}

post() {
    : # TODO: add checks
}
`;

// ---------------------------------------------------------------------------
// Known helper registry (mirrors setup_helpers/HELPER_REGISTRY keys)
// ---------------------------------------------------------------------------

const HELPER_REGISTRY: ReadonlySet<string> = new Set([
  "create_base_repo",
  "add_worktree",
  "detach_head",
  "symlink_superpowers",
  "install_codex_superpowers_plugin_hooks",
  "add_existing_worktree",
  "detach_worktree_head",
  "link_gemini_extension",
  "create_caller_consent_plan",
  "create_spec_writing_blind_spot",
  "create_claim_without_verification",
  "create_phantom_completion",
  "create_review_pushback",
  "create_spec_targets_wrong_component",
  "create_spec_targets_wrong_component_with_checkpoint",
  "add_stub_executing_plan",
  "create_writing_plans_skeleton",
  "create_code_review_planted_bugs",
  "add_flawed_spec_for_review",
  "add_sdd_auth_plan",
  "scaffold_sdd_broken_plan",
  "scaffold_sdd_go_fractals",
  "scaffold_sdd_go_fractals_crisp",
  "scaffold_sdd_go_fractals_coarse",
  "scaffold_sdd_go_fractals_control_plan",
  "scaffold_sdd_go_fractals_critical_plan",
  "scaffold_sdd_go_fractals_elicited",
  "scaffold_sdd_go_fractals_stripped",
  "scaffold_sdd_svelte_todo",
  "scaffold_sdd_svelte_todo_elicited",
  "scaffold_sdd_quality_defect_plan",
  "scaffold_sdd_spec_constraint_plan",
  "scaffold_sdd_yagni_plan",
  "setup_pressure_worktree_conditions",
  "create_cost_checkbox_page",
  "create_cost_clean_repo",
  "create_cost_trivial_plan",
  "create_cost_large_files",
  "record_head",
]);

// ---------------------------------------------------------------------------
// Valid quorum_tier values (mirrors quorum/story_meta.py)
// ---------------------------------------------------------------------------

const VALID_TIERS: ReadonlySet<string> = new Set(["sentinel", "full", "adhoc"]);

// ---------------------------------------------------------------------------
// Public error class
// ---------------------------------------------------------------------------

/** Raised when a scenario cannot be scaffolded. */
export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScaffoldError";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a structurally-valid scenario skeleton; return its directory path.
 */
export function newScenario(scenariosRoot: string, name: string): string {
  const scenarioDir = path.join(scenariosRoot, name);
  if (fs.existsSync(scenarioDir)) {
    throw new ScaffoldError(`scenario already exists: ${scenarioDir}`);
  }
  fs.mkdirSync(scenarioDir, { recursive: true });

  fs.writeFileSync(
    path.join(scenarioDir, "story.md"),
    _STORY_TEMPLATE.replace("{name}", name),
  );

  const setupPath = path.join(scenarioDir, "setup.sh");
  fs.writeFileSync(setupPath, _SETUP_TEMPLATE);
  fs.chmodSync(setupPath, 0o755);

  // checks.sh: sourced via `bash <path>`, not executed directly — no chmod.
  fs.writeFileSync(path.join(scenarioDir, "checks.sh"), _CHECKS_TEMPLATE);

  return scenarioDir;
}

/**
 * Return a list of structural problems; empty list means valid.
 */
export function checkScenario(scenarioDir: string): string[] {
  const problems: string[] = [];

  const storyPath = path.join(scenarioDir, "story.md");
  if (!fs.existsSync(storyPath)) {
    problems.push("story.md missing");
  } else {
    const text = fs.readFileSync(storyPath, "utf8");
    const fm = _parseFrontmatter(text);
    for (const key of ["id", "title"] as const) {
      if (!(key in fm)) {
        problems.push(`story.md frontmatter missing '${key}'`);
      }
    }
    if (!text.includes("## Acceptance Criteria")) {
      problems.push("story.md missing '## Acceptance Criteria' section");
    }
    const tier = fm["quorum_tier"] as string | undefined;
    if (tier !== undefined && !VALID_TIERS.has(tier)) {
      problems.push(
        `story.md quorum_tier=${JSON.stringify(tier)} is not valid ` +
          `(expected one of: ${[...VALID_TIERS].join(", ")})`,
      );
    }
  }

  const setupPath = path.join(scenarioDir, "setup.sh");
  if (fs.existsSync(setupPath)) {
    if (!_isExecutable(setupPath)) {
      problems.push("setup.sh is not executable");
    }
    const setupText = fs.readFileSync(setupPath, "utf8");
    for (const match of setupText.matchAll(/setup-helpers\s+run\s+(.+)/g)) {
      const helpers = (match[1] ?? "").trim().split(/\s+/);
      for (const helper of helpers) {
        if (!HELPER_REGISTRY.has(helper)) {
          problems.push(`setup.sh references unknown helper '${helper}'`);
        }
      }
    }
  }

  problems.push(..._validateChecksSh(scenarioDir));

  return problems;
}

/**
 * chmod +x setup.sh if missing the bit.
 * Returns the scenario-relative paths that were fixed.
 */
export function fixExecutableBits(scenarioDir: string): string[] {
  const fixed: string[] = [];
  for (const scriptPath of _scenarioScripts(scenarioDir)) {
    if (!_isExecutable(scriptPath)) {
      const stat = fs.statSync(scriptPath);
      fs.chmodSync(scriptPath, stat.mode | 0o111);
      fixed.push(path.relative(scenarioDir, scriptPath));
    }
  }
  return fixed;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function _parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---")) {
    return {};
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return {};
  }
  try {
    const parsed = yamlParse(text.slice(3, end)) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function _validateChecksSh(scenarioDir: string): string[] {
  const csPath = path.join(scenarioDir, "checks.sh");
  const problems: string[] = [];

  if (!fs.existsSync(csPath)) {
    problems.push("checks.sh missing");
    return problems;
  }

  // Syntax check via bash -n
  const proc = spawnSync("bash", ["-n", csPath], { encoding: "utf8" });
  if (proc.status !== 0) {
    problems.push(`checks.sh syntax error: ${(proc.stderr ?? "").trim()}`);
    return problems;
  }

  const text = fs.readFileSync(csPath, "utf8");
  const lines = text.split("\n");

  // Functions-only check: track brace depth; function-declaration lines open a scope.
  // Single-line bodies like `pre() { :; }` are fully contained on one line.
  let inFn = 0;
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith("#")) {
      continue;
    }
    const isFnDecl = /^(pre|post)\s*\(\)/.test(s);
    const opens = (s.match(/\{/g) ?? []).length;
    const closes = (s.match(/\}/g) ?? []).length;
    if (isFnDecl) {
      inFn = Math.max(0, inFn + opens - closes);
      continue;
    }
    if (s === "{") {
      inFn += 1;
      continue;
    }
    if (s === "}") {
      inFn = Math.max(0, inFn - 1);
      continue;
    }
    if (inFn === 0) {
      problems.push(
        `checks.sh must be functions-only (top-level statement: ${JSON.stringify(s.slice(0, 60))})`,
      );
      break;
    }
  }

  if (!/^pre\s*\(\)/m.test(text)) {
    problems.push("checks.sh missing pre() function");
  }
  if (!/^post\s*\(\)/m.test(text)) {
    problems.push("checks.sh missing post() function");
  }

  // Concurrency lint: warn on backgrounded check invocations (single & not &&).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*#/.test(line)) continue;
    // Match a single & that is not part of && and is followed only by optional whitespace and (comment or EOL)
    if (/(?<!&)&(?!&)\s*(#|$)/.test(line)) {
      problems.push(`checks.sh:${i + 1}: backgrounded check (\`&\`) is unsupported`);
    }
  }

  // $QUORUM_WORKDIR lint: not available in the new model
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\$\{?QUORUM_WORKDIR\b/.test(line)) {
      problems.push(
        `checks.sh:${i + 1}: $QUORUM_WORKDIR is not available; ` +
          "cwd is the workdir — use relative paths",
      );
    }
  }

  return problems;
}

/** Every script quorum execs directly: setup.sh only. */
function _scenarioScripts(scenarioDir: string): string[] {
  const scripts = [path.join(scenarioDir, "setup.sh")];
  return scripts.filter((p) => fs.existsSync(p));
}
