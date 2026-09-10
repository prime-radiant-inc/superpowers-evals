export interface CapturedSource {
  id: string;
  nativePath: string;
  sha256: string;
  /** Path relative to runDir, or null when normalization failed. */
  trajectoryPath: string | null;
  error: string | null;
}

export interface SourceIndex {
  schemaVersion: 1;
  sources: CapturedSource[];
  mergedSteps: Array<{
    mergedStepId: number;
    sourceId: string;
    sourceStepId: number;
  }>;
}
