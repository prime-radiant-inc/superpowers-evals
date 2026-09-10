// Entirely synthetic evidence for checker tests; no live skill-behavior claim.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AtifTrajectory } from '../../../src/atif/types.ts';
import type { SourceIndex } from '../../../src/capture/source-index.ts';
import {
  DIMENSIONS,
  type DiagnosisArtifacts,
  type DiagnosisKey,
  type DiagnosisReview,
} from '../../../src/experiments/diagnosis/contracts.ts';

export const sha = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
export const json = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
export const read = <T>(path: string): T =>
  JSON.parse(readFileSync(path, 'utf8')) as T;
export const native = (line: number, timestamp?: string, origin?: string) => ({
  quorum_source: {
    lines: [line],
    ...(timestamp ? { timestamp } : {}),
    ...(origin ? { origin } : {}),
  },
});
const trajectory = (
  id: string,
  steps: AtifTrajectory['steps'],
): AtifTrajectory => ({
  schema_version: 'ATIF-v1.7',
  agent: { name: 'pi', version: 'synthetic' },
  session_id: id,
  steps,
});

export function syntheticAssessment(root: string) {
  const runDir = join(root, 'run');
  const keyPath = join(root, 'private', 'key.json');
  const reviewPath = join(root, 'private', 'review.json');
  const original = '/synthetic/home';
  const sourcePath = `${original}/sessions/root.jsonl`;
  const reportPath = `${original}/diagnosis/report.md`;
  const casePath = `${original}/diagnosis/case.md`;
  const commonPath = `${original}/diagnosis/common.md`;
  const artifacts: DiagnosisArtifacts = {
    schemaVersion: 1,
    files: [],
    preservation: [],
    errors: [],
  };
  function file(originalPath: string, retainedPath: string, contents: string) {
    const path = join(runDir, retainedPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    artifacts.files.push({
      originalPath,
      retainedPath,
      sha256: sha(contents),
      bytes: Buffer.byteLength(contents),
    });
  }
  function indexed(
    index: SourceIndex,
    id: string,
    nativePath: string,
    trajectoryPath: string,
    t: AtifTrajectory,
    texts: string[],
  ) {
    const retainedPath = id.startsWith('history')
      ? `diagnosis-history/native/${id}.jsonl`
      : `home/sessions/${id}.jsonl`;
    const bytes = `${texts.map((text) => JSON.stringify({ text })).join('\n')}\n`;
    file(nativePath, retainedPath, bytes);
    file(
      join(runDir, trajectoryPath),
      trajectoryPath,
      `${JSON.stringify(t, null, 2)}\n`,
    );
    index.sources.push({
      id,
      nativePath,
      trajectoryPath,
      sha256: sha(bytes),
      error: null,
    });
  }
  const history: SourceIndex = {
    schemaVersion: 1,
    sources: [],
    mergedSteps: [],
  };
  const current: SourceIndex = {
    schemaVersion: 1,
    sources: [],
    mergedSteps: [],
  };
  indexed(
    history,
    'history-root',
    sourcePath,
    'diagnosis-history/atif-sources/root.json',
    trajectory('old-root', [
      {
        step_id: 1,
        source: 'user',
        message: 'Inspect the synthetic bug.',
        timestamp: '2026-01-01T00:00:00Z',
        extra: native(1, undefined, 'human'),
      },
      {
        step_id: 2,
        source: 'agent',
        message: 'Observed "synthetic" failure.',
        timestamp: '2026-01-01T00:00:01Z',
        extra: native(2),
        metrics: {
          prompt_tokens: 1249,
          completion_tokens: 10,
          extra: native(2, '2026-01-01T00:00:01Z'),
        },
      },
      {
        step_id: 3,
        source: 'agent',
        message: 'Legitimate reread after changes.',
        timestamp: '2026-01-01T00:00:03Z',
        extra: native(3),
      },
    ]),
    [
      'Inspect the synthetic bug.',
      'Observed "synthetic" failure.',
      'Legitimate reread after changes.',
    ],
  );
  indexed(
    history,
    'history-child',
    `${original}/sessions/child.jsonl`,
    'diagnosis-history/atif-sources/child.json',
    trajectory('old-child', [
      {
        step_id: 1,
        source: 'user',
        message: 'Parent dispatch, not a human request.',
        timestamp: '2026-01-01T00:00:01Z',
        extra: native(1, undefined, 'parent'),
      },
      {
        step_id: 2,
        source: 'agent',
        message: 'Child usage unavailable.',
        timestamp: '2026-01-01T00:00:02Z',
        extra: native(2),
      },
    ]),
    ['Parent dispatch, not a human request.', 'Child usage unavailable.'],
  );
  const manifest = {
    schemaVersion: 1,
    harness: 'pi',
    files: history.sources.map((s, i) => ({
      path: i ? 'child.jsonl' : 'root.jsonl',
      destination: 'session-store',
      relativePath: i ? 'child.jsonl' : 'root.jsonl',
      sha256: s.sha256,
    })),
  };
  for (const [i, s] of history.sources.entries())
    artifacts.preservation.push({
      source: i ? 'child.jsonl' : 'root.jsonl',
      installedPath: s.nativePath,
      expectedSha256: s.sha256,
      actualSha256: s.sha256,
      status: 'unchanged',
    });
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  file(
    '/synthetic/corpus/manifest.json',
    'diagnosis-history/manifest.json',
    manifestBytes,
  );
  file(
    casePath,
    'diagnosis-artifacts/case.md',
    'Target old-root and linked old-child.\n',
  );
  file(
    commonPath,
    'diagnosis-artifacts/common.md',
    'Read only. Cite evidence.\n',
  );
  const controllerSteps: AtifTrajectory['steps'] = [];
  const analysts: DiagnosisReview['analysts'] = [];
  for (const [i, dimension] of DIMENSIONS.entries()) {
    const dimensionPath = `${original}/skills/${dimension}.md`;
    file(
      dimensionPath,
      `diagnosis-artifacts/${dimension}.md`,
      `Analyze ${dimension}.\n`,
    );
    const childSourceId = `analyst-${i}`;
    const prompt = `Read ${casePath}, ${commonPath}, ${dimensionPath}`;
    controllerSteps.push({
      step_id: i + 1,
      source: 'agent',
      timestamp: '2026-01-02T00:00:01Z',
      extra: native(i + 1),
      tool_calls: [
        {
          tool_call_id: `dispatch-${i}`,
          function_name: 'Agent',
          arguments: { prompt },
          extra: {
            ...native(i + 1),
            quorum_child: {
              relationship: 'spawned',
              path: `${original}/sessions/${childSourceId}.jsonl`,
            },
          },
        },
      ],
    });
    indexed(
      current,
      childSourceId,
      `${original}/sessions/${childSourceId}.jsonl`,
      `atif-sources/${childSourceId}.json`,
      trajectory(`new-${i}`, [
        {
          step_id: 1,
          source: 'user',
          message: prompt,
          timestamp: '2026-01-02T00:00:02Z',
          extra: native(1, undefined, 'parent'),
        },
        {
          step_id: 2,
          source: 'agent',
          message: `Completed ${dimension}; checked scope, including empty findings.`,
          timestamp: '2026-01-02T00:00:03Z',
          extra: native(2),
        },
      ]),
      [
        prompt,
        `Completed ${dimension}; checked scope, including empty findings.`,
      ],
    );
    analysts.push({
      dimension,
      sourceId: 'controller',
      dispatchStepId: i + 1,
      callId: `dispatch-${i}`,
      batchIndex: null,
      childSourceId,
      completionStepId: 2,
      casePath,
      commonPath,
      dimensionPath,
    });
  }
  controllerSteps.push({
    step_id: 8,
    source: 'agent',
    message: `Report written to ${reportPath}`,
    timestamp: '2026-01-02T00:00:04Z',
    extra: native(8),
  });
  indexed(
    current,
    'controller',
    `${original}/sessions/controller.jsonl`,
    'atif-sources/controller.json',
    trajectory('new-controller', controllerSteps),
    [
      ...DIMENSIONS.map((d) => `Dispatch ${d}`),
      `Report written to ${reportPath}`,
    ],
  );
  const reportLines = [
    '# Synthetic diagnosis',
    `Target old-root at ${sourcePath}; historical sessions old-root and old-child.`,
    `Human request: Inspect the synthetic bug. [source](${sourcePath}:1)`,
    `Observed "synthetic" failure. [source](${sourcePath}:2)`,
    `Legitimate reread after changes. [source](${sourcePath}:3)`,
    'Root prompt usage: 1249 tokens; child usage unavailable.',
    'Elapsed root window: 3000 ms.',
    'Request conflicts: none found after checking all human turns and actions.',
  ];
  const report = `${reportLines.join('\n')}\n`;
  file(reportPath, 'diagnosis-artifacts/report.md', report);
  file(
    join(runDir, 'diagnosis-history/atif-sources.json'),
    'diagnosis-history/atif-sources.json',
    `${JSON.stringify(history, null, 2)}\n`,
  );
  json(join(runDir, 'atif-sources.json'), current);
  const key: DiagnosisKey = {
    schemaVersion: 1,
    harness: 'pi',
    manifestSha256: sha(manifestBytes),
    sessions: [
      {
        id: 'old-root',
        role: 'root',
        source: 'root.jsonl',
        parentId: null,
        evidence: [{ source: 'root.jsonl', line: 1 }],
      },
      {
        id: 'old-child',
        role: 'child',
        source: 'child.jsonl',
        parentId: 'old-root',
        evidence: [{ source: 'child.jsonl', line: 1 }],
      },
    ],
    humanTurns: [
      {
        id: 'human-1',
        text: 'Inspect the synthetic bug.',
        timestamp: '2026-01-01T00:00:00Z',
        evidence: [{ source: 'root.jsonl', line: 1 }],
      },
    ],
    requiredFindings: [
      {
        id: 'failure',
        dimension: 'stumbles',
        statement: 'Observed synthetic failure.',
        evidence: [{ source: 'root.jsonl', line: 2 }],
      },
    ],
    negativeControls: [
      {
        id: 'reread',
        dimension: 'repeated-work',
        statement: 'Reread after edits is legitimate.',
        evidence: [{ source: 'root.jsonl', line: 3 }],
      },
    ],
    quantities: [
      {
        id: 'prompt',
        value: 1249,
        unit: 'tokens',
        scope: 'root request prompt',
        evidence: [{ source: 'root.jsonl', line: 2 }],
        alternatives: [
          {
            value: 1259,
            scope: 'root prompt plus completion',
            evidence: [{ source: 'root.jsonl', line: 2 }],
          },
        ],
      },
      {
        id: 'child-usage',
        value: null,
        unit: 'tokens',
        scope: 'child missing usage',
        evidence: [{ source: 'child.jsonl', line: 2 }],
      },
      {
        id: 'elapsed',
        value: 3000,
        unit: 'ms',
        measurement: 'elapsed-time',
        scope: 'root first human to last assistant',
        evidence: [
          { source: 'root.jsonl', line: 1 },
          { source: 'root.jsonl', line: 3 },
        ],
      },
    ],
    capabilities: {},
  };
  const item = {
    status: 'pass' as const,
    reason:
      'Independent synthetic evidence review; checked all relevant records.',
    evidence: [{ source: 'root.jsonl', line: 1 }],
  };
  json(keyPath, key);
  const review: DiagnosisReview = {
    schemaVersion: 1,
    reportSha256: sha(report),
    keySha256: sha(readFileSync(keyPath)),
    targetSessionId: 'old-root',
    sourcePath,
    reportPath,
    historicalSessionIds: ['old-root', 'old-child'],
    humanTurnIds: ['human-1'],
    recoveredFindingIds: ['failure'],
    quantities: [
      {
        id: 'prompt',
        claimId: 'claim-6',
        value: 1249,
        scope: 'root request prompt',
        rounding: null,
      },
      {
        id: 'child-usage',
        claimId: 'claim-6',
        value: null,
        scope: 'child missing usage',
        rounding: null,
      },
      {
        id: 'elapsed',
        claimId: 'claim-7',
        value: 3000,
        scope: 'root first human to last assistant',
        rounding: null,
      },
    ],
    claims: reportLines.slice(1).map((text, i) => ({
      id: `claim-${i + 2}`,
      reportLines: [i + 2, i + 2],
      text,
      citations:
        i === 1
          ? [
              {
                path: sourcePath,
                line: 1,
                quote: 'Inspect the synthetic bug.',
              },
            ]
          : i === 2
            ? [
                {
                  path: sourcePath,
                  line: 2,
                  quote: 'Observed "synthetic" failure.',
                },
              ]
            : i === 3
              ? [
                  {
                    path: sourcePath,
                    line: 3,
                    quote: 'Legitimate reread after changes.',
                  },
                ]
              : [],
      judgment: 'supported',
      reason:
        'Independent synthetic reviewer confirms precise meaning, scope, precision, and evidence.',
    })),
    nonClaimLines: [
      { start: 1, end: 1, reason: 'Heading, no factual assertion.' },
    ],
    analysts,
    dimensions: Object.fromEntries(
      DIMENSIONS.map((d) => [
        d,
        {
          ...item,
          reason:
            d === 'request-conflicts'
              ? 'Empty dimension; all requests and actions checked with no conflict.'
              : item.reason,
        },
      ]),
    ) as DiagnosisReview['dimensions'],
    rubric: Object.fromEntries(
      [
        'case',
        'environment',
        'timeline',
        'coverage',
        'involvement',
        'contextSafety',
        'scope',
        'exposure',
        'reportDelivery',
        'negativeControls',
      ].map((r) => [
        r,
        { ...item, evidence: [{ source: 'controller', line: 1 }] },
      ]),
    ) as DiagnosisReview['rubric'],
    reviewer: 'independent synthetic reviewer',
    blinded: true,
    unblindingReason: null,
  };
  const save = () => {
    json(keyPath, key);
    review.keySha256 = sha(readFileSync(keyPath));
    json(reviewPath, review);
    json(join(runDir, 'diagnosis-artifacts.json'), artifacts);
  };
  save();
  return {
    runDir,
    keyPath,
    reviewPath,
    key,
    review,
    artifacts,
    history,
    current,
    save,
    reportPath,
    sourcePath,
    report,
    file,
  };
}
