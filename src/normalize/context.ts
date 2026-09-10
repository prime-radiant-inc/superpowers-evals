export const PI_ZERO_COST_NORMALIZATION_POLICY =
  'unconfigured-provider-model-rates' as const;

export interface PiPlaceholderZeroCostContext {
  readonly provider: string;
  readonly model: string;
  readonly policy: typeof PI_ZERO_COST_NORMALIZATION_POLICY;
}

/** Optional facts known at provisioning time that qualify native-log values.
 * Historical normalization omits this context and retains its original
 * interpretation. */
export interface AtifNormalizationContext {
  readonly pi?: {
    readonly placeholderZeroCost?: PiPlaceholderZeroCostContext;
  };
}
