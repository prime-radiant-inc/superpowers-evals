import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const AgentConfigSchema = z.object({
  name: z.string(),
  runtime_family: z.string().optional(),
  binary: z.string(),
  agent_config_env: z.string(),
  session_log_dir: z.string(),
  session_log_glob: z.string(),
  normalizer: z.string(),
  required_env: z.array(z.string()).default([]),
  max_time: z.string().optional(),
  project_prompt: z.string().optional(),
  model: z.string().optional(),
  // PRI-2203 scheduler keys (parsed now, consumed in Spec 4)
  max_concurrency: z.number().int().min(1).optional(),
  launch_spacing_seconds: z.number().min(0).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// Thrown when a coding-agent YAML is structurally valid but a referenced file
// cannot be resolved (mirrors quorum/coding_agent_config.py:CodingAgentConfigError
// for the project_prompt-existence leg). The runner maps it to a setup-stage
// indeterminate via errorStage.
export class CodingAgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodingAgentConfigError';
  }
}

export function loadAgentConfig(
  codingAgentsDir: string,
  name: string,
): AgentConfig {
  const path = join(codingAgentsDir, `${name}.yaml`);
  const raw: unknown = parseYaml(readFileSync(path, 'utf8'));
  const cfg = AgentConfigSchema.parse(raw);

  // Resolve project_prompt relative to the YAML file's dir to an absolute path
  // and require it to exist, mirroring quorum/coding_agent_config.py:
  //   candidate = (path.parent / project_prompt_raw).resolve()
  //   if not candidate.is_file(): raise ...
  // Gauntlet's --project-prompt needs an absolute, existing file; the raw
  // "claude.project-prompt.md" alone fails ("file not found"). Overwrite the
  // parsed field with the resolved absolute path so invokeGauntlet passes it.
  if (cfg.project_prompt !== undefined && cfg.project_prompt !== '') {
    const candidate = resolve(dirname(path), cfg.project_prompt);
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      throw new CodingAgentConfigError(
        `${path}: project_prompt path does not exist: ${candidate}`,
      );
    }
    return { ...cfg, project_prompt: candidate };
  }
  return cfg;
}

/** Replace ${VAR} occurrences from a map. Unknown vars are left intact (mirrors Python). */
export function substituteEnv(
  text: string,
  vars: Readonly<Record<string, string>>,
): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (whole, key: string) => {
    const value = vars[key];
    return value !== undefined ? value : whole;
  });
}
