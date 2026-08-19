// TEMPORARY cutover freeze (Tasks 2-4 of the F13 filesystem plan). The
// scoped credential runtime is being landed in stages: the staging/activation
// primitives exist (credential-scope.ts) but production callers have not been
// switched to them yet. Until Task 5 performs that atomic cutover, every
// production execution path — the prepare/run/run-all program actions and the
// detached worker resume — must refuse AFTER argument and structural-config
// validation but BEFORE job creation, state mutation, credential-aware
// loading, bundle payload access, or Docker. There is no bypass, test-only or
// otherwise. Task 5 deletes this module and its imports in the same commit as
// the complete caller cutover.
import { ApplianceError } from './errors.ts';

export function assertScopedCredentialCutover(action: string): void {
  throw new ApplianceError(
    'config_invalid',
    'scoped-cutover',
    `scoped credential cutover incomplete: ${action} is disabled until the scoped credential runtime lands (F13 Task 5)`,
  );
}
