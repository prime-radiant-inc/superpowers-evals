import { readdirSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  agentRuntimeFamily,
  loadAgentConfigForValidation,
} from '../contracts/agent-config.ts';
import { parseCredentialsFile } from '../contracts/credential.ts';

/**
 * Validate that every agent with a `default_credential` has that credential
 * present in the credentials file and that the credential's `harnesses` list
 * includes the agent's runtime family.
 *
 * Agents without a `default_credential` are skipped — they do not require a
 * credential entry (e.g. antigravity, copilot).
 */
export function checkCredentials(
  credentialsPath: string,
  codingAgentsDir: string,
): { ok: boolean; errors: string[] } {
  // Step 1: parse the credentials file; surface parse errors without throwing.
  let credentials: Record<string, { harnesses: string[] }>;
  try {
    const raw: unknown = parseYaml(readFileSync(credentialsPath, 'utf8'));
    credentials = parseCredentialsFile(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`credentials file error: ${message}`] };
  }

  const errors: string[] = [];

  // Step 2: enumerate every *.yaml in the coding-agents dir.
  let agentFiles: string[];
  try {
    agentFiles = readdirSync(codingAgentsDir).filter((f) =>
      f.endsWith('.yaml'),
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [`cannot read coding-agents dir: ${message}`],
    };
  }

  for (const file of agentFiles) {
    const name = file.slice(0, -'.yaml'.length);
    let cfg: ReturnType<typeof loadAgentConfigForValidation>;
    try {
      cfg = loadAgentConfigForValidation(codingAgentsDir, name);
    } catch {
      // If the agent YAML is invalid, skip it — agent-config validation is
      // separate from credential validation.
      continue;
    }

    // Step 3: check only agents that declare a default_credential.
    const credName = cfg.default_credential;
    if (credName === undefined) {
      continue;
    }

    const family = agentRuntimeFamily(cfg);
    const cred = credentials[credName];

    if (cred === undefined) {
      errors.push(
        `${name}: default_credential '${credName}' not found in ${credentialsPath}`,
      );
      continue;
    }

    if (!cred.harnesses.includes(family)) {
      errors.push(
        `${name}: credential '${credName}' does not list harness '${family}'`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}
