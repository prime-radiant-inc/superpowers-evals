// Grid manifest contract — the authoritative scenario × agent × os eligibility
// matrix emitted by the harness and consumed by the dashboard read-side.

export interface GridManifestCell {
  readonly scenario: string;
  readonly agent: string;
  // The credential name this cell runs under ('' for credential-less agents).
  readonly credential: string;
  readonly os: string;
  readonly eligible: boolean;
  readonly skipped_reason:
    | 'directive'
    | 'draft'
    | 'tier'
    | 'harness'
    | 'os'
    | null;
}

export interface GridManifest {
  readonly generated_at: string;
  readonly scenarios: readonly string[];
  readonly agents: readonly string[];
  readonly cells: readonly GridManifestCell[];
}
