import { z } from 'zod';
import { jcsCanonicalize, sha256Hex } from '../contracts/campaign/digest.ts';
import {
  CheckRequirementSchema,
  CriterionRequirementSchema,
  type MeasurementRequirements,
} from '../contracts/campaign/measurement.ts';
import type { PricingSnapshot } from '../contracts/campaign/suite.ts';
import { CheckManifestSchema } from '../contracts/check-manifest.ts';
import { projectConversationStory } from '../runner/conversation-input.ts';
import { quorumModeFromStory } from '../story-meta.ts';

export function consumedReference(
  files: Record<string, string>,
  ref: PricingSnapshot,
): string {
  if (
    ref.path.split('/').some((p) => p === '' || p === '.' || p === '..') ||
    ref.path.includes('\\')
  )
    throw new Error('invalid consumed reference path');
  const bytes = files[ref.path];
  if (bytes === undefined || sha256Hex(bytes) !== ref.sha256)
    throw new Error(`consumed reference hash mismatch: ${ref.path}`);
  return bytes;
}
const DeclaredScenario = z.object({
  mode: z.enum(['qa', 'conversation']),
  story_sha256: z.string(),
  rubric_sha256: z.string(),
  criteria: z.array(CriterionRequirementSchema),
  checks: z.array(CheckRequirementSchema),
  oracle_authority: z.object({ check_manifest_sha256: z.string() }),
});
const Requirements = z.object({
  schema_version: z.literal(1),
  scenarios: z.record(z.string(), DeclaredScenario),
});
/** Freeze source obligations without deriving evidence dependencies or verdicts from prose. */
export function resolveMeasurementRequirements(args: {
  files: Record<string, string>;
  scenarios: string[];
  reference?: PricingSnapshot;
}): MeasurementRequirements {
  const declared = args.reference
    ? Requirements.parse(
        JSON.parse(consumedReference(args.files, args.reference)),
      ).scenarios
    : undefined;
  const result: MeasurementRequirements = {};
  for (const name of new Set(args.scenarios)) {
    const story = args.files[`scenarios/${name}/story.md`];
    const manifestBytes = args.files[`scenarios/${name}/checks-manifest.json`];
    if (story === undefined || manifestBytes === undefined)
      throw new Error(`measurement source missing: ${name}`);
    const manifest = CheckManifestSchema.parse(JSON.parse(manifestBytes));
    const mode = quorumModeFromStory(story);
    const rubric =
      mode === 'conversation' ? projectConversationStory(story).rubric : story;
    const text = story.split(/^## Acceptance Criteria\s*$/m)[1] ?? '';
    const criteria: string[] = [];
    let current: number | null = null;
    for (const line of text.split('\n')) {
      if (/^#{2,}\s/.test(line)) break;
      const bullet = /^(?:\d+\.|[-*])\s+(.+)$/.exec(line);
      if (bullet?.[1]) {
        criteria.push(bullet[1].trim());
        current = criteria.length - 1;
      } else if (/^[ \t]+\S/.test(line) && current !== null) {
        criteria[current] = `${criteria[current]} ${line.trim()}`;
      } else if (line.trim()) current = null;
    }
    const source = declared?.[name];
    if (declared && !source)
      throw new Error(`measurement declaration missing: ${name}`);
    const hashes = {
      story_sha256: sha256Hex(story),
      rubric_sha256: sha256Hex(rubric),
      check_manifest_sha256: sha256Hex(manifestBytes),
    };
    if (
      source &&
      (source.mode !== mode ||
        source.story_sha256 !== hashes.story_sha256 ||
        source.rubric_sha256 !== hashes.rubric_sha256 ||
        source.oracle_authority.check_manifest_sha256 !==
          hashes.check_manifest_sha256)
    )
      throw new Error(`measurement source changed: ${name}`);
    if (
      source &&
      (source.criteria.length !== criteria.length ||
        source.criteria.some(
          (c, i) =>
            c.ordinal !== i + 1 ||
            c.id !== `${name}:${i + 1}` ||
            c.text !== criteria[i] ||
            c.check_refs.some(
              (r) =>
                !source.checks.some((check) => check.ordinal === r.ordinal),
            ),
        ))
    )
      throw new Error(`criterion inventory mismatch: ${name}`);
    if (
      source &&
      (source.checks.length !== manifest.entries.length ||
        source.checks.some(
          (c, i) =>
            c.ordinal !== i ||
            jcsCanonicalize({
              phase: c.phase,
              check: c.check,
              args: c.args,
              negated: c.negated,
              count: c.count,
            }) !== jcsCanonicalize(manifest.entries[i]),
        ))
    )
      throw new Error(`check inventory mismatch: ${name}`);
    result[name] = {
      mode,
      ...hashes,
      criteria:
        source?.criteria ??
        criteria.map((text, i) => ({
          id: `${name}:${i + 1}`,
          ordinal: i + 1,
          text,
          required_artifact_classes: [],
          check_refs: [],
        })),
      checks:
        source?.checks ??
        manifest.entries.map((entry, ordinal) => ({
          ...entry,
          ordinal,
          authority: {
            kind: 'unclassified',
            sources: [`scenarios/${name}/checks.sh`],
          },
        })),
    };
  }
  return result;
}
