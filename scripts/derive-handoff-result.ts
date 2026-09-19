import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type ArtifactLabel = 'A' | 'B';
type DraftStage = 'initial' | 'final';
type Outcome = 'green' | 'safe_tie' | 'failure';

interface DerivedHandoffResult {
  readonly outcome: Outcome;
  readonly initialLabel: ArtifactLabel;
  readonly finalLabel: ArtifactLabel;
  readonly initialBurden: number;
  readonly finalBurden: number;
  readonly finalOnlyMinorBurdens: string;
  readonly finalOnlyMajorBurdens: string;
  readonly finalOnlyContradictions: string;
  readonly finalOnlyDesignDrift: string;
}

function parseBlock(reasoning: string): Map<string, string> {
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

function burden(fields: Map<string, string>, label: ArtifactLabel): number {
  const value = Number(required(fields, `${label}_TOTAL_BURDEN`));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid ${label}_TOTAL_BURDEN: ${String(value)}`);
  }
  return value;
}

function isNone(value: string): boolean {
  return value.trim().toLowerCase() === 'none';
}

export function deriveHandoffResult(
  manifestPath: string,
  judgeResultPath: string,
): DerivedHandoffResult {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    labels?: Record<ArtifactLabel, DraftStage>;
  };
  const result = JSON.parse(readFileSync(judgeResultPath, 'utf8')) as {
    reasoning?: string;
  };
  if (!manifest.labels || typeof result.reasoning !== 'string') {
    throw new Error('invalid manifest or judge result');
  }

  const initialLabel = (['A', 'B'] as const).find(
    (label) => manifest.labels?.[label] === 'initial',
  );
  const finalLabel = (['A', 'B'] as const).find(
    (label) => manifest.labels?.[label] === 'final',
  );
  if (!initialLabel || !finalLabel || initialLabel === finalLabel) {
    throw new Error('manifest must map one initial and one final artifact');
  }

  const fields = parseBlock(result.reasoning);
  const initialBurden = burden(fields, initialLabel);
  const finalBurden = burden(fields, finalLabel);
  const finalOnlyMinorBurdens = required(
    fields,
    `${finalLabel}_UNIQUE_MINOR_BURDENS`,
  );
  const finalOnlyMajorBurdens = required(
    fields,
    `${finalLabel}_UNIQUE_MAJOR_BURDENS`,
  );
  const finalOnlyContradictions = required(
    fields,
    `${finalLabel}_UNIQUE_CONTRADICTIONS`,
  );
  const finalOnlyDesignDrift = required(
    fields,
    `${finalLabel}_UNIQUE_DESIGN_DRIFT`,
  );

  const blindDir = dirname(manifestPath);
  const byteIdentical =
    readFileSync(join(blindDir, 'A.md')).equals(
      readFileSync(join(blindDir, 'B.md')),
    );
  const disqualified =
    !isNone(finalOnlyMajorBurdens) ||
    !isNone(finalOnlyContradictions) ||
    !isNone(finalOnlyDesignDrift);
  const outcome: Outcome =
    finalBurden < initialBurden && !disqualified
      ? 'green'
      : byteIdentical && finalBurden === initialBurden && !disqualified
        ? 'safe_tie'
        : 'failure';

  return {
    outcome,
    initialLabel,
    finalLabel,
    initialBurden,
    finalBurden,
    finalOnlyMinorBurdens,
    finalOnlyMajorBurdens,
    finalOnlyContradictions,
    finalOnlyDesignDrift,
  };
}

if (import.meta.main) {
  const [manifestPath, judgeResultPath] = process.argv.slice(2);
  if (!manifestPath || !judgeResultPath) {
    throw new Error('usage: derive-handoff-result <manifest.json> <result.json>');
  }
  console.log(JSON.stringify(deriveHandoffResult(manifestPath, judgeResultPath), null, 2));
}
