import { readdirSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  agentRuntimeFamily,
  loadAgentConfigForValidation,
} from '../contracts/agent-config.ts';
import {
  type Credential,
  parseCredentialsFile,
} from '../contracts/credential.ts';
import { isSerfOpenRouterCampaignCredentialV1 } from './serf-openrouter-profile.ts';

export function campaignCredentialErrors(
  credentials: Readonly<Record<string, Credential>>,
): string[] {
  const errors: string[] = [];
  for (const [name, credential] of Object.entries(credentials)) {
    if (
      credential.harnesses.includes('serf') &&
      !isSerfOpenRouterCampaignCredentialV1(credential)
    ) {
      errors.push(
        `credential '${name}' must use the exact Serf OpenRouter campaign v1 profile and complete route-attestation labels`,
      );
    }
  }
  return errors;
}

export function assertCampaignCredentials(
  credentials: Readonly<Record<string, Credential>>,
): void {
  const errors = campaignCredentialErrors(credentials);
  if (errors.length > 0) {
    throw new Error(`invalid external campaign: ${errors.join('; ')}`);
  }
}

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
  options: {
    readonly requireAgentDefaults?: boolean;
    readonly externalCampaign?: boolean;
  } = {},
): { ok: boolean; errors: string[] } {
  // Step 1: parse the credentials file; surface parse errors without throwing.
  let credentials: Record<string, Credential>;
  try {
    const raw: unknown = parseYaml(readFileSync(credentialsPath, 'utf8'));
    credentials = parseCredentialsFile(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`credentials file error: ${message}`] };
  }

  const errors: string[] = [];

  if (options.externalCampaign === true) {
    errors.push(...campaignCredentialErrors(credentials));
  }

  // Every mantle credential must declare a region (the Mantle endpoint URL is
  // built from it; an omitted region would seed a malformed host).
  for (const [credName, cred] of Object.entries(credentials)) {
    if (
      cred.api === 'mantle' &&
      (cred.region === undefined || cred.region === '')
    ) {
      errors.push(`credential '${credName}' has api: mantle but no region`);
    }
  }

  // External campaign files are intentionally narrow candidate registries,
  // not replacements for the canonical defaults used by every coding agent.
  if (options.requireAgentDefaults === false) {
    return { ok: errors.length === 0, errors };
  }

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
      errors: [...errors, `cannot read coding-agents dir: ${message}`],
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
