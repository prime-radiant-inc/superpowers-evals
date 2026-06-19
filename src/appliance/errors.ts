import { z } from 'zod';

export const ApplianceErrorCodeSchema = z.enum([
  'config_invalid',
  'lock_busy',
  'repo_dirty',
  'fetch_failed',
  'ref_ambiguous',
  'ref_not_found',
  'checkout_failed',
  'image_build_failed',
  'container_recreate_required',
  'container_unhealthy',
  'tool_versions_failed',
  'quorum_check_failed',
  'unsupported_os',
  'job_not_found',
  'job_not_running',
  'cancel_failed',
  'artifact_missing',
]);
export type ApplianceErrorCode = z.infer<typeof ApplianceErrorCodeSchema>;

export interface ErrorJson {
  readonly ok: false;
  readonly error: {
    readonly code: ApplianceErrorCode;
    readonly step: string;
    readonly message: string;
  };
}

export class ApplianceError extends Error {
  readonly code: ApplianceErrorCode;
  readonly step: string;

  constructor(code: ApplianceErrorCode, step: string, message: string) {
    super(message);
    this.name = 'ApplianceError';
    this.code = code;
    this.step = step;
  }
}

export function toErrorJson(err: unknown): ErrorJson {
  if (err instanceof ApplianceError) {
    return {
      ok: false,
      error: { code: err.code, step: err.step, message: err.message },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: { code: 'config_invalid', step: 'unknown', message },
  };
}
