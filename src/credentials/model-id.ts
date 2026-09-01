/** The native Anthropic model id behind a request id. Bedrock (and its
 *  Anthropic-compatible Mantle surface) names Anthropic models with a vendor
 *  prefix — `anthropic.claude-opus-4-8` is `claude-opus-4-8` served through
 *  Bedrock. A credential registers the prefixed request id; the API answers
 *  (and the agent's transcript records) the native id. Identity comparisons
 *  key on the native id; anything carried verbatim (the request itself,
 *  pricing lookups, display) keeps the prefixed form. */
export function nativeModelId(model: string): string {
  return model.replace(/^anthropic\./, '');
}
