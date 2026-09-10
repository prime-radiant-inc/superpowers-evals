import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { z } from 'zod';
import { checkCriterionAgreement } from '../../docs/experiments/2026-09-08-conversation-routine-use/cases.ts';
import {
  readPinnedNoFollowBytes,
  shellSingleQuote,
} from '../appliance/credential-scope.ts';
import {
  ConversationRecordSchema,
  EvidenceIndexSchema,
} from '../contracts/conversation.ts';
import { GauntletResultSchema } from '../contracts/gauntlet.ts';
import { getEnv } from '../env.ts';
import { estimateUsageSidecar } from '../obol/index.ts';
import { readAssessmentCompletion } from './assessment-completion.ts';
import { invokeGauntletRole } from './gauntlet-role.ts';
import {
  authenticateQualificationRef,
  type QualificationMeasurement,
  qualificationRef,
  readQualificationFile as readPrivate,
  writeQualificationJson,
} from './qualification-evidence.ts';
import type { QualificationSettlement } from './qualification-set.ts';
import {
  reconcileAssessmentAccounting,
  verifyReturnedTurns,
} from './role-usage.ts';

type Verdict = 'pass' | 'fail' | 'unclear';
export type QualificationRoleInput =
  | {
      kind: 'assessment';
      rubricPath: string;
      evidenceRoot: string;
      evidenceIndexPath: string;
      expected: Verdict[];
      groups: { originalOrdinal: number; atomicOrdinals: number[] }[];
      originalVerdicts: Verdict[];
    }
  | {
      kind: 'driver';
      briefPath: string;
      subjectScriptPath: string;
      subjectCase: string;
      expectedCompletion: 'delivery' | 'refusal';
    };

type Rubric = { id: string; acceptanceCriteria: string[] };
const ResultSchema = GauntletResultSchema.extend({
  summary: z.string().trim().min(1),
  reasoning: z.string().trim().min(1),
  scenario: z.string(),
  criteria: z.array(
    z.object({
      criterion: z.string(),
      verdict: z.enum(['pass', 'fail', 'unclear']),
      evidence: z.string(),
    }),
  ),
  usage: z.object({ turns: z.number().int().positive() }),
});
function sidecar(out: string, name: string): string {
  return (
    readPinnedNoFollowBytes(
      out,
      [name],
      'qualification sidecar',
      false,
    )?.toString('utf8') ?? ''
  );
}

/** Caller policy and expectations stay in the parent; child argv projects paths only. */
export async function executeQualificationRole(input: {
  gRoot: string;
  runDir: string;
  model: 'anthropic.claude-sonnet-5';
  env: Record<string, string | undefined>;
  stopped(): boolean;
  role: QualificationRoleInput;
}): Promise<QualificationSettlement> {
  const { runDir, model, env, stopped, role: policy } = input;
  const { parseStoryCard } = (await import(
    join(input.gRoot, 'src/format/story-card.ts')
  )) as {
    parseStoryCard(text: string): Rubric;
  };
  const { makeRunId } = (await import(join(input.gRoot, 'src/util/id.ts'))) as {
    makeRunId(id: string): string;
  };
  const rubric =
    policy.kind === 'assessment'
      ? parseStoryCard(readPrivate(policy.rubricPath).toString('utf8'))
      : null;
  const id =
    rubric?.id ??
    (policy.kind === 'driver' ? policy.subjectCase : 'assessment');
  const outDir = join('role', makeRunId(id));
  const out = join(runDir, outDir);
  const started = performance.now();
  for (const dir of [
    out,
    ...['home', 'tmp', 'workspace', 'subject-home', 'subject-tmp'].map((p) =>
      join(runDir, p),
    ),
  ])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = (path: string) => ({
    out_dir: path,
    model,
    started_at: null,
    finished_at: null,
    process_exit: null,
    stop_cause: null,
  });
  const assessment = policy.kind === 'assessment';
  writeQualificationJson(join(runDir, 'gauntlet-roles.json'), {
    conversation: record(assessment ? 'unused' : outDir),
    assessment: record(assessment ? outDir : 'unused'),
  });
  const expectation = writeQualificationJson(
    join(runDir, 'qualification-expectation.json'),
    policy.kind === 'assessment'
      ? {
          expected: policy.expected,
          groups: policy.groups,
          originalVerdicts: policy.originalVerdicts,
        }
      : { expectedCompletion: policy.expectedCompletion },
  );
  const metrics: QualificationMeasurement = {
    kind: policy.kind,
    accepted: false,
    actual: null,
    result: null,
    inputs: [],
    artifacts: [],
    expectation,
    firstReportValid: null,
    eventualReportCompletion: false,
    logicalAttempts: null,
    logicalResponses: null,
    physicalAttempts: null,
    corrections: null,
    unknownUsageAttemptIds: null,
    costComplete: false,
    knownUsd: 0,
    totalUsd: null,
    latencyMs: 0,
  };
  const socketPath = join(runDir, 'tmux');
  const completion = join(runDir, 'conversation.json');
  const launcher = join(runDir, 'launcher');
  let fault: string | null = null,
    semanticMatch = false,
    complete = false,
    knownUsd = 0;
  let result: z.infer<typeof ResultSchema> | null = null;
  let coverage: ReturnType<typeof reconcileAssessmentAccounting> | null = null;
  let pricingPath = join(out, 'usage.jsonl');
  let pricingDir: string | undefined;
  try {
    if (policy.kind === 'assessment') {
      if (
        !rubric ||
        rubric.acceptanceCriteria.length !== policy.expected.length
      )
        throw Error('qualification rubric count mismatch');
      checkCriterionAgreement(
        policy.groups,
        policy.expected,
        policy.originalVerdicts,
        policy.expected,
      );
      const index = EvidenceIndexSchema.parse(
        JSON.parse(readPrivate(policy.evidenceIndexPath).toString('utf8')),
      );
      metrics.inputs = [
        policy.rubricPath,
        policy.evidenceIndexPath,
        ...index.files.map((p) => {
          const path = realpathSync(join(policy.evidenceRoot, p));
          const rel = relative(realpathSync(policy.evidenceRoot), path);
          if (rel.startsWith('../') || rel === '..')
            throw Error('evidence outside root');
          return path;
        }),
      ].map(qualificationRef);
    } else {
      metrics.inputs = [policy.briefPath, policy.subjectScriptPath].map(
        qualificationRef,
      );
      const args = [
        process.execPath,
        policy.subjectScriptPath,
        policy.subjectCase,
      ]
        .map(shellSingleQuote)
        .join(' ');
      writeFileSync(
        launcher,
        `#!/bin/sh\nexec /usr/bin/env -i PATH=${shellSingleQuote(getEnv('PATH') ?? '/usr/bin:/bin')} HOME=${shellSingleQuote(join(runDir, 'subject-home'))} TMPDIR=${shellSingleQuote(join(runDir, 'subject-tmp'))} ${args}\n`,
        { mode: 0o700, flag: 'wx' },
      );
    }
    const argv =
      policy.kind === 'assessment'
        ? [
            'assess',
            policy.rubricPath,
            '--evidence-root',
            policy.evidenceRoot,
            '--evidence-index',
            policy.evidenceIndexPath,
          ]
        : [
            'converse',
            policy.briefPath,
            '--launcher',
            launcher,
            '--workspace',
            join(runDir, 'workspace'),
            '--tmux-socket',
            socketPath,
            '--completion',
            completion,
          ];
    const processRecord = await invokeGauntletRole({
      role: assessment ? 'assessment' : 'conversation',
      binary: process.execPath,
      argv: [
        join(input.gRoot, 'src/index.ts'),
        ...argv,
        '--out',
        out,
        '--model',
        `agent=${model}`,
        '--max-time',
        '2m',
      ],
      runDir,
      env: { ...env, HOME: join(runDir, 'home'), TMPDIR: join(runDir, 'tmp') },
      deadlineMs: 120_000,
      shouldStop: stopped,
      ...(assessment ? {} : { socketPath }),
    });
    if (
      processRecord.started_at === null ||
      processRecord.finished_at === null ||
      processRecord.stop_cause !== null ||
      processRecord.process_exit?.signal !== null
    )
      throw Error('role did not complete');
    if (policy.kind === 'assessment') {
      const terminal = readAssessmentCompletion({
        outDir: out,
        runId: basename(out),
      });
      if (terminal.status !== 'completed')
        throw Error('assessment did not complete');
      metrics.eventualReportCompletion = true;
      result = ResultSchema.parse(
        JSON.parse(readPrivate(join(out, 'result.json')).toString('utf8')),
      );
      if (
        result.runId !== basename(out) ||
        result.scenario !== rubric?.id ||
        result.criteria.length !== rubric.acceptanceCriteria.length ||
        result.criteria.some(
          (c, i) =>
            c.criterion !== rubric.acceptanceCriteria[i] || !c.evidence.trim(),
        )
      )
        throw Error('assessment final evidence invalid');
      const actual = result.criteria.map((c) => c.verdict);
      const status = actual.includes('fail')
        ? 'fail'
        : actual.includes('unclear')
          ? 'investigate'
          : 'pass';
      if (
        result.status !== status ||
        processRecord.process_exit?.code !== (status === 'pass' ? 0 : 1)
      )
        throw Error('assessment final/exit mismatch');
      semanticMatch = checkCriterionAgreement(
        policy.groups,
        policy.expected,
        policy.originalVerdicts,
        actual,
      ).match;
    } else {
      verifyReturnedTurns({
        model,
        runJsonl: sidecar(out, 'run.jsonl'),
        usageJsonl: sidecar(out, 'usage.jsonl'),
      });
      const driver = ConversationRecordSchema.parse(
        JSON.parse(readPrivate(completion).toString('utf8')),
      );
      if (
        driver.status !== 'completed' ||
        !driver.evidence ||
        processRecord.process_exit?.code !== 0
      )
        throw Error('driver endpoint invalid');
      EvidenceIndexSchema.parse({ files: [driver.evidence.path] });
      const capture = realpathSync(join(runDir, driver.evidence.path));
      const path = relative(out, capture);
      if (!path.startsWith('captures/') || !path.endsWith('.ansi'))
        throw Error('driver endpoint must name a capture');
      readPrivate(capture);
      const gridPath = capture.replace(/\.ansi$/, '.json');
      const grid = z
        .object({ cells: z.array(z.array(z.object({ ch: z.string() }))) })
        .parse(JSON.parse(readPrivate(gridPath).toString('utf8')));
      const rendered = grid.cells
        .map((row) =>
          row
            .map((cell) => cell.ch)
            .join('')
            .trimEnd(),
        )
        .join('\n')
        .trimEnd();
      if (!rendered.includes(driver.evidence.quote))
        throw Error('endpoint quote not present in retained capture');
      metrics.artifacts.push(...[capture, gridPath].map(qualificationRef));
      metrics.result = qualificationRef(completion);
      metrics.eventualReportCompletion = true;
      semanticMatch = driver.endpoint === policy.expectedCompletion;
    }
    complete = true;
  } catch {
    fault = 'invalid or interrupted role evidence';
  }
  // Reconcile even after evidence/exit validation failed. Obol priceability is
  // never substituted for strict accounting or logical closure.
  try {
    const run = sidecar(out, 'run.jsonl');
    const events = run
      .split('\n')
      .slice(0, -1)
      .flatMap((line) => {
        try {
          return [z.record(z.unknown()).parse(JSON.parse(line))];
        } catch {
          return [];
        }
      });
    metrics.logicalAttempts = events.filter(
      (e) => e['type'] === 'llm_request',
    ).length;
    metrics.logicalResponses = events.filter(
      (e) => e['type'] === 'llm_response',
    ).length;
    if (assessment) {
      try {
        metrics.eventualReportCompletion =
          readAssessmentCompletion({ outDir: out, runId: basename(out) })
            .status === 'completed';
      } catch {
        /* No authenticated accepted-report completion. */
      }
      const attemptsJsonl = sidecar(out, 'assessment-attempts.jsonl');
      coverage = reconcileAssessmentAccounting({
        runJsonl: run,
        usageJsonl: sidecar(out, 'usage.jsonl'),
        attemptsJsonl,
      });
      let expectedModel = false;
      try {
        expectedModel = attemptsJsonl
          .split('\n')
          .filter(Boolean)
          .every((line) => {
            const event = z.record(z.unknown()).parse(JSON.parse(line));
            return (
              event['event'] !== 'admission' ||
              (event['provider'] === 'anthropic' && event['model'] === model)
            );
          });
      } catch {
        /* Strict accounting records the malformed evidence separately. */
      }
      metrics.physicalAttempts = coverage.accounting.physicalAttempts;
      metrics.unknownUsageAttemptIds =
        coverage.accounting.unknownUsageAttemptIds;
      const reports = events.filter(
        (e) => e['type'] === 'tool_call' && e['name'] === 'report_result',
      );
      const rejected = events.filter(
        (e) =>
          e['type'] === 'tool_result' &&
          e['name'] === 'report_result' &&
          e['error'] === true,
      );
      metrics.corrections = rejected.length;
      metrics.firstReportValid =
        reports.length === 0
          ? null
          : rejected.some((e) => e['toolUseId'] === reports[0]?.['toolUseId'])
            ? false
            : metrics.eventualReportCompletion && reports.length === 1
              ? true
              : null;
      if (
        !expectedModel ||
        !coverage.reportEligible ||
        result?.usage.turns !== coverage.accounting.logicalResponses
      ) {
        complete = false;
        fault ??= 'invalid assessment accounting or missing logical closure';
      }
      pricingDir = mkdtempSync(join(runDir, '.qualification-pricing-'));
      pricingPath = join(pricingDir, 'usage.jsonl');
      writeFileSync(pricingPath, coverage.knownUsageJsonl, { mode: 0o600 });
    }
  } catch {
    complete = false;
    fault ??= 'settled usage unavailable';
    // An unreadable assessment ledger cannot justify pricing raw rows.
    if (assessment) pricingPath = '';
  }
  try {
    const usage = pricingPath ? await estimateUsageSidecar(pricingPath) : null;
    if (
      usage?.est_cost_usd != null &&
      Number.isFinite(usage.est_cost_usd) &&
      usage.est_cost_usd >= 0
    )
      knownUsd = usage.est_cost_usd;
    if (
      !usage ||
      usage.unpriced_models.length ||
      usage.est_cost_usd === null ||
      !Number.isFinite(usage.est_cost_usd) ||
      usage.est_cost_usd < 0
    ) {
      complete = false;
      fault ??= 'settled usage missing or unpriceable';
    } else metrics.costComplete = coverage?.complete ?? false;
  } catch {
    complete = false;
    fault ??= 'settled usage missing or unpriceable';
  } finally {
    try {
      if (pricingDir) rmSync(pricingDir, { recursive: true });
    } catch {
      complete = false;
      fault ??= 'qualification pricing cleanup failed';
    }
  }
  try {
    for (const ref of metrics.inputs) authenticateQualificationRef(ref);
    metrics.accepted = complete && fault === null;
    if (assessment && metrics.accepted && result) {
      metrics.actual = result.criteria.map((c) => c.verdict);
      metrics.result = qualificationRef(join(out, 'result.json'));
    }
    for (const name of [
      'run.jsonl',
      'usage.jsonl',
      ...(assessment
        ? ['assessment-attempts.jsonl', 'assessment-completion.json']
        : []),
    ]) {
      try {
        metrics.artifacts.push(qualificationRef(join(out, name)));
      } catch {
        if (metrics.accepted)
          throw Error('required qualification artifact missing');
      }
    }
    metrics.knownUsd = knownUsd;
    metrics.totalUsd = metrics.costComplete ? knownUsd : null;
    metrics.latencyMs = performance.now() - started;
    writeQualificationJson(join(runDir, 'qualification-role.json'), metrics);
  } catch {
    complete = false;
    fault ??= 'qualification measurement publication or binding failed';
  }
  return { knownUsd, complete, semanticMatch, fault };
}
