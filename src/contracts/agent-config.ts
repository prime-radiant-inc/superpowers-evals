import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

export function loadAgentConfig(
  codingAgentsDir: string,
  name: string,
): AgentConfig {
  const path = join(codingAgentsDir, `${name}.yaml`);
  const raw: unknown = parseYaml(readFileSync(path, 'utf8'));
  return AgentConfigSchema.parse(raw);
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
