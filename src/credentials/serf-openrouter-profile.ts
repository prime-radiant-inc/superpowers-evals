import type { Credential, CredentialLabels } from '../contracts/credential.ts';

export const SERF_OPENROUTER_V1_BASE_URL = 'https://openrouter.ai/api/v1';
export const SERF_OPENROUTER_V1_API_KEY_ENV = 'OPENROUTER_API_KEY';

export type SerfOpenRouterCampaignCredentialV1 = Credential & {
  readonly labels: CredentialLabels;
};

// The one campaign profile whose runtime route and charge can be attested.
// Exact values are intentional: custom endpoints and trailing-slash variants
// do not select the same Serf/OpenRouter provider profile.
export function isSerfOpenRouterCampaignCredentialV1(
  credential: Credential,
): credential is SerfOpenRouterCampaignCredentialV1 {
  return (
    credential.harnesses.includes('serf') &&
    credential.model.match(
      /^openrouter\/@preset\/[a-z0-9]+(?:[-_.][a-z0-9]+)*$/,
    ) !== null &&
    credential.api === 'openai-chat' &&
    credential.base_url === SERF_OPENROUTER_V1_BASE_URL &&
    credential.auth === 'api-key' &&
    credential.api_key_env === SERF_OPENROUTER_V1_API_KEY_ENV &&
    credential.labels !== undefined
  );
}
