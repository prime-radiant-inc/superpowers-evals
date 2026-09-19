import { readFileSync } from 'node:fs';

type ArtifactLabel = 'A' | 'B';
type DraftLabel = 'original' | 'tentative';

interface FallbackResult {
  readonly outcome: 'fallback_green' | 'failure';
  readonly tentativeLabel: ArtifactLabel;
  readonly originalLabel: ArtifactLabel;
  readonly selectedOriginal: boolean;
  readonly tentativeDisqualifier: boolean;
}

function parseFields(reasoning: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of reasoning.split('\n')) {
    const match = /^([A-Z_]+):\s*(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      fields.set(match[1], match[2]);
    }
  }
  return fields;
}

function required(fields: Map<string, string>, key: string): string {
  const value = fields.get(key);
  if (value === undefined) throw new Error(`missing judge field: ${key}`);
  return value;
}

function isNone(value: string): boolean {
  return value.trim().toLowerCase() === 'none';
}

export function deriveFallbackResult(
  manifestPath: string,
  judgeResultPath: string,
  selectedPath: string,
  originalPath: string,
  tentativePath: string,
): FallbackResult {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    labels?: Record<ArtifactLabel, DraftLabel>;
  };
  const judge = JSON.parse(readFileSync(judgeResultPath, 'utf8')) as {
    reasoning?: string;
  };
  if (!manifest.labels || typeof judge.reasoning !== 'string') {
    throw new Error('invalid manifest or judge result');
  }
  const tentativeLabel = (['A', 'B'] as const).find(
    (label) => manifest.labels?.[label] === 'tentative',
  );
  const originalLabel = (['A', 'B'] as const).find(
    (label) => manifest.labels?.[label] === 'original',
  );
  if (!tentativeLabel || !originalLabel || tentativeLabel === originalLabel) {
    throw new Error('manifest must map one original and one tentative artifact');
  }

  const selected = readFileSync(selectedPath);
  const original = readFileSync(originalPath);
  const tentative = readFileSync(tentativePath);
  const selectedOriginal = selected.equals(original) && !selected.equals(tentative);
  const fields = parseFields(judge.reasoning);
  const tentativeDisqualifier = [
    `${tentativeLabel}_UNIQUE_MAJOR_BURDENS`,
    `${tentativeLabel}_UNIQUE_CONTRADICTIONS`,
    `${tentativeLabel}_UNIQUE_DESIGN_DRIFT`,
  ].some((key) => !isNone(required(fields, key)));

  return {
    outcome:
      selectedOriginal && tentativeDisqualifier ? 'fallback_green' : 'failure',
    tentativeLabel,
    originalLabel,
    selectedOriginal,
    tentativeDisqualifier,
  };
}

if (import.meta.main) {
  const [manifest, result, selected, original, tentative] = process.argv.slice(2);
  if (!manifest || !result || !selected || !original || !tentative) {
    throw new Error(
      'usage: derive-fallback-result <manifest> <result> <selected> <original> <tentative>',
    );
  }
  console.log(
    JSON.stringify(
      deriveFallbackResult(manifest, result, selected, original, tentative),
      null,
      2,
    ),
  );
}
