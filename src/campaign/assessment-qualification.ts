import { z } from 'zod';
import { jcsCanonicalize, sha256Hex } from '../contracts/campaign/digest.ts';
import type { Experiment } from '../contracts/campaign/experiment.ts';
import {
  AssessmentQualificationRecordSchema,
  type QualificationCoverage,
} from '../contracts/campaign/measurement.ts';
import { CredentialSchema } from '../contracts/credential.ts';
import { consumedReference } from './measurement-requirements.ts';

const CaseManifest = z.object({
  schema_version: z.literal(1),
  assessments_per_case: z.number().int().positive(),
  cases: z
    .array(
      z.object({
        id: z.string().min(1),
        rubric_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        expected: z
          .array(
            z.object({
              criterion: z.number().int().positive(),
              verdict: z.enum(['pass', 'fail', 'unclear']),
              required_reason: z.string().min(1),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});
/** Public source semantics exclude data-only qualification commits to avoid a circular containing SHA. */
export function evidenceSemanticsDigest(files: Record<string, string>): string {
  const paths = Object.keys(files)
    .filter(
      (p) => p.startsWith('src/') || p === 'package.json' || p === 'bun.lock',
    )
    .sort();
  if (
    !paths.includes('package.json') ||
    !paths.includes('bun.lock') ||
    !paths.some((p) => p.startsWith('src/'))
  )
    throw new Error('missing evidence semantics source inventory');
  return sha256Hex(
    jcsCanonicalize(
      Object.fromEntries(
        paths.map((p) => {
          const bytes = files[p];
          if (bytes === undefined) throw new Error('missing source bytes');
          return [p, sha256Hex(bytes)];
        }),
      ),
    ),
  );
}
export function evaluateQualification(args: {
  experiment: Experiment;
  files: Record<string, string>;
  credential: unknown;
}): QualificationCoverage | undefined {
  const { experiment, files } = args;
  const reference = experiment.suite.assessment_qualification;
  if (!reference) return undefined;
  const record = AssessmentQualificationRecordSchema.parse(
    JSON.parse(consumedReference(files, reference)),
  );
  const configuration = sha256Hex(
    jcsCanonicalize(CredentialSchema.parse(args.credential)),
  );
  const commonMatches =
    record.gauntlet_sha === experiment.refs.gauntlet &&
    record.grader.credential === experiment.grader.credential &&
    record.grader.model === experiment.grader.model &&
    record.grader.configuration_sha256 === configuration &&
    record.evidence_semantics_sha256 === evidenceSemanticsDigest(files);
  return {
    reference,
    scopes: record.scopes.map((scope) => {
      const manifest = CaseManifest.parse(
        JSON.parse(consumedReference(files, scope.case_manifest)),
      );
      const requirements =
        experiment.measurement_requirements?.[scope.scenario];
      const reasons: string[] = [];
      if (!commonMatches) reasons.push('source or grader binding mismatch');
      if (
        !requirements ||
        requirements.rubric_sha256 !== scope.rubric_sha256 ||
        new Set(scope.criterion_ids).size !== scope.criterion_ids.length ||
        scope.criterion_ids.some(
          (id) => !requirements.criteria.some((c) => c.id === id),
        ) ||
        record.scopes.filter((s) => s.scenario === scope.scenario).length !== 1
      )
        reasons.push('rubric or criterion scope mismatch');
      const cells = experiment.cells.filter(
        (c) => c.scenario === scope.scenario,
      );
      if (
        !cells.length ||
        cells.some((c) =>
          c.arms.some((arm) => {
            const b =
              experiment.role_budgets?.[`${c.comparison_id}:${c.scenario}`]?.[
                arm
              ];
            return (
              b?.assessment_ms !== scope.assessment_ms ||
              b?.assessment_report_grace_ms !== scope.report_grace_ms
            );
          }),
        )
      )
        reasons.push('assessment budget mismatch');
      if (
        new Set(manifest.cases.map((c) => c.id)).size !==
          manifest.cases.length ||
        scope.observations.length !==
          manifest.cases.length * manifest.assessments_per_case
      )
        reasons.push('case or replicate inventory mismatch');
      for (const expectedCase of manifest.cases) {
        if (
          expectedCase.rubric_sha256 !== scope.rubric_sha256 ||
          new Set(expectedCase.expected.map((r) => r.criterion)).size !==
            expectedCase.expected.length ||
          scope.criterion_ids.some(
            (id) =>
              !expectedCase.expected.some((r) =>
                requirements?.criteria.some(
                  (c) => c.id === id && c.ordinal === r.criterion,
                ),
              ),
          )
        )
          reasons.push('case rubric or criterion coverage mismatch');
        for (
          let replicate = 1;
          replicate <= manifest.assessments_per_case;
          replicate++
        ) {
          const matches = scope.observations.filter(
            (o) => o.case_id === expectedCase.id && o.replicate === replicate,
          );
          const observation = matches[0];
          if (
            matches.length !== 1 ||
            !observation?.completed ||
            observation.criteria.length !== expectedCase.expected.length ||
            expectedCase.expected.some((expected) => {
              const rows = observation.criteria.filter(
                (r) => r.criterion === expected.criterion,
              );
              return (
                rows.length !== 1 ||
                rows[0]?.verdict !== expected.verdict ||
                rows[0]?.reason_support !== 'supported'
              );
            })
          )
            reasons.push(
              `unverified case ${expectedCase.id} replicate ${replicate}`,
            );
        }
      }
      return {
        scenario: scope.scenario,
        criterion_ids: scope.criterion_ids,
        status: reasons.length
          ? ('unverified' as const)
          : ('qualified' as const),
        reason: reasons.length
          ? [...new Set(reasons)].join('; ')
          : 'Exact bindings and every expected case/replicate judgment and reason support verified. Cost coverage remains separate.',
      };
    }),
  };
}

/** Both registration intake passes consume exactly the same public binding files. */
export function consumeQualificationInputs(args: {
  files: Record<string, string>;
  reference: { path: string; sha256: string };
  paths: string[];
  read: (path: string) => string;
}): void {
  const record = AssessmentQualificationRecordSchema.parse(
    JSON.parse(consumedReference(args.files, args.reference)),
  );
  for (const scope of record.scopes) {
    const path = scope.case_manifest.path;
    if (
      path.split('/').some((p) => p === '' || p === '.' || p === '..') ||
      path.includes('\\')
    )
      throw new Error('invalid qualification manifest path');
    args.files[path] = args.read(path);
    consumedReference(args.files, scope.case_manifest);
  }
  for (const path of args.paths.filter(
    (p) => p.startsWith('src/') || p === 'package.json' || p === 'bun.lock',
  ))
    args.files[path] = args.read(path);
  evidenceSemanticsDigest(args.files);
}
