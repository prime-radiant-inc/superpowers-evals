import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AtifTrajectory } from '../src/atif/types.ts';
import { assessDiagnosis } from '../src/experiments/diagnosis/assessment.ts';
import {
  type AssessmentStatus,
  DiagnosisKeySchema,
} from '../src/experiments/diagnosis/contracts.ts';
import { normalizeClaudeLegacy } from '../src/normalize/claude.ts';
import { normalizeCodex } from '../src/normalize/codex.ts';
import {
  NATIVE_RESULT_CASES,
  nativeDurationBoundary,
  nativeDurationResult,
  nativeReadResult,
} from './fixtures/diagnosis/native-results.ts';
import {
  json,
  native,
  read,
  sha,
  syntheticAssessment,
} from './fixtures/diagnosis/synthetic-assessment.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-assessment-'));
  roots.push(root);
  return syntheticAssessment(root);
}
type Fixture = ReturnType<typeof fixture>;
function check(
  f: Fixture,
  name: string,
  status: AssessmentStatus,
  overall = status,
) {
  f.save();
  const result = assessDiagnosis(f);
  expect(result.checks.find((c) => c.name === name)?.status).toBe(status);
  expect(result.status).toBe(overall);
  return result;
}
function trajectory(
  f: Fixture,
  path: string,
  mutate: (t: AtifTrajectory) => void,
) {
  const absolute = join(f.runDir, path);
  const t = read<AtifTrajectory>(absolute);
  mutate(t);
  json(absolute, t);
  const row = f.artifacts.files.find((file) => file.retainedPath === path)!;
  const bytes = readFileSync(absolute);
  row.sha256 = sha(bytes);
  row.bytes = bytes.length;
}
// Replace the entire source with production-normalized invented native records.
// Rebind the synthetic source index and fixture manifest to those exact bytes.
function nativeSource(
  f: Fixture,
  path: string,
  raw: string,
  normalize: typeof normalizeCodex,
) {
  const index = path.startsWith('diagnosis-history/') ? f.history : f.current;
  const source = index.sources.find((s) => s.trajectoryPath === path)!;
  const replace = (retainedPath: string, bytes: string) => {
    writeFileSync(join(f.runDir, retainedPath), bytes);
    const row = f.artifacts.files.find((r) => r.retainedPath === retainedPath);
    if (row)
      Object.assign(row, {
        sha256: sha(bytes),
        bytes: Buffer.byteLength(bytes),
      });
  };
  replace(
    f.artifacts.files.find((r) => r.originalPath === source.nativePath)!
      .retainedPath,
    raw,
  );
  source.sha256 = sha(raw);
  replace(path, JSON.stringify(normalize(raw, 'synthetic')));
  const indexPath =
    index === f.history
      ? 'diagnosis-history/atif-sources.json'
      : 'atif-sources.json';
  replace(indexPath, JSON.stringify(index));
  if (index === f.history) {
    const manifestPath = 'diagnosis-history/manifest.json';
    const manifest = read<{ files: { path: string; sha256: string }[] }>(
      join(f.runDir, manifestPath),
    );
    const preservation = f.artifacts.preservation.find(
      (p) => p.installedPath === source.nativePath,
    )!;
    preservation.expectedSha256 = source.sha256;
    preservation.actualSha256 = source.sha256;
    manifest.files.find((entry) => entry.path === preservation.source)!.sha256 =
      source.sha256;
    const bytes = JSON.stringify(manifest);
    replace(manifestPath, bytes);
    f.key.manifestSha256 = sha(bytes);
  }
}
function claudeSidechain(
  f: Fixture,
  path: string,
  sessionId: string,
  agentId: string,
) {
  const t = read<AtifTrajectory>(join(f.runDir, path));
  const raw = t.steps
    .map((step) =>
      JSON.stringify({
        type: step.source === 'agent' ? 'assistant' : 'user',
        sessionId,
        agentId,
        isSidechain: true,
        timestamp: step.timestamp,
        message: {
          content:
            step.source === 'agent'
              ? [{ type: 'text', text: step.message }]
              : step.message,
        },
      }),
    )
    .join('\n');
  nativeSource(f, path, raw, normalizeClaudeLegacy);
}
function currentClaudeSidechains(f: Fixture, duplicate = false) {
  for (let i = 0; i < 7; i++)
    claudeSidechain(
      f,
      `atif-sources/analyst-${i}.json`,
      'new-controller',
      `native-${duplicate && i === 6 ? 0 : i}`,
    );
  trajectory(f, 'atif-sources/controller.json', (t) => {
    for (let i = 0; i < 7; i++)
      t.steps[i]!.tool_calls![0]!.extra!['quorum_child'] = {
        relationship: 'spawned',
        id: `native-${i}`,
      };
  });
}
function report(f: Fixture, before: string, after: string) {
  const row = f.artifacts.files.find(
    (file) => file.originalPath === f.reportPath,
  )!;
  const bytes = readFileSync(join(f.runDir, row.retainedPath), 'utf8').replace(
    before,
    after,
  );
  // Update the retained report and its collection-time identity; reviewer rebinds exact bytes.
  const claim = f.review.claims.find((c) => c.text.includes(before));
  if (claim) claim.text = claim.text.replace(before, after);
  writeFileSync(join(f.runDir, row.retainedPath), bytes);
  row.sha256 = sha(bytes);
  row.bytes = Buffer.byteLength(bytes);
  f.review.reportSha256 = sha(bytes);
}

test('correct synthetic prose, alternative citation and evidenced empty dimension pass', () => {
  const f = fixture();
  const result = check(f, 'dimension:request-conflicts', 'pass');
  expect(
    result.checks.find((c) => c.name === 'citation:claim-5:0')?.status,
  ).toBe('pass');
});
test('same report copied elsewhere remains valid through explicit original reportPath', () => {
  const f = fixture();
  f.file(
    '/synthetic/copy/report.md',
    'coding-agent-workdir/report.md',
    f.report,
  );
  check(f, 'report-identity', 'pass');
});
for (const [name, mutate, reason] of [
  [
    'wrong target',
    (f: Fixture) => {
      f.review.targetSessionId = 'decoy';
    },
    'target-session',
  ],
  [
    'wrong absolute source root',
    (f: Fixture) => {
      f.review.sourcePath = '/other/root.jsonl';
    },
    'source-path',
  ],
  [
    'historical child omitted',
    (f: Fixture) => {
      f.review.historicalSessionIds.pop();
    },
    'historical-sessions',
  ],
  [
    'parent dispatch labeled human',
    (f: Fixture) => {
      f.review.humanTurnIds.push('parent-dispatch');
    },
    'human-turns',
  ],
  [
    'cumulative usage double counted',
    (f: Fixture) => {
      f.review.quantities[0]!.value = 2498;
    },
    'quantity:prompt',
  ],
  [
    'missing usage claimed zero',
    (f: Fixture) => {
      f.review.quantities[1]!.value = 0;
    },
    'quantity:child-usage',
  ],
  [
    'incorrect scope',
    (f: Fixture) => {
      f.review.quantities[0]!.scope = 'all sessions';
    },
    'quantity:prompt',
  ],
  [
    'missing required finding',
    (f: Fixture) => {
      f.review.recoveredFindingIds = [];
    },
    'required-findings',
  ],
  [
    'claimed success without evidence',
    (f: Fixture) => {
      f.review.claims[2]!.judgment = 'unsupported';
      f.review.claims[2]!.reason = 'No test execution supports success.';
    },
    'claim:claim-4',
  ],
  [
    'legitimate reread called waste',
    (f: Fixture) => {
      f.review.claims[3]!.judgment = 'unsupported';
      f.review.claims[3]!.reason = 'Reread followed an edit and is legitimate.';
    },
    'claim:claim-5',
  ],
  [
    'existing irrelevant citation',
    (f: Fixture) => {
      report(f, `${f.sourcePath}:2`, `${f.sourcePath}:3`);
      f.review.claims[2]!.citations = [
        {
          path: f.sourcePath,
          line: 3,
          quote: 'Legitimate reread after changes.',
        },
      ];
      f.review.claims[2]!.judgment = 'unsupported';
      f.review.claims[2]!.reason = 'Quote does not entail this failure claim.';
    },
    'claim:claim-4',
  ],
  [
    'only six executions behind seven dimensions',
    (f: Fixture) => {
      f.review.analysts.pop();
    },
    'analyst-executions',
  ],
  [
    'duplicate child execution',
    (f: Fixture) => {
      f.review.analysts[6]!.childSourceId = 'analyst-0';
    },
    'analyst-executions',
  ],
] as const)
  test(name, () => {
    const f = fixture();
    mutate(f);
    check(f, reason, 'fail');
  });

test('scoped alternative and display rounding use frozen literal measurements', () => {
  const f = fixture();
  const q = f.review.quantities[0]!;
  report(f, '1249 tokens', '1.3 kTokens (prompt plus completion)');
  q.scope = 'root prompt plus completion';
  q.value = 1300;
  q.rounding = { unit: 'kTokens', decimalPlaces: 1, mode: 'nearest' };
  const result = check(f, 'quantity:prompt', 'pass');
  expect(
    result.checks.find((c) => c.name === 'quantity:prompt')?.detail,
  ).toContain('1259');
  expect(
    result.checks.find((c) => c.name === 'quantity:prompt')?.detail,
  ).toContain('1300');
});
test('rounded value outside declared precision fails', () => {
  const f = fixture();
  f.review.quantities[0]!.value = 1400;
  f.review.quantities[0]!.rounding = {
    unit: 'kTokens',
    decimalPlaces: 1,
    mode: 'nearest',
  };
  check(f, 'quantity:prompt', 'fail');
});
test('incompatible display units fail', () => {
  const f = fixture();
  f.review.quantities[0]!.rounding = {
    unit: 's',
    decimalPlaces: 1,
    mode: 'nearest',
  };
  check(f, 'quantity:prompt', 'fail');
});
test('floor rounding needs retained convention evidence', () => {
  const f = fixture();
  f.review.quantities[0]!.value = 1200;
  f.review.quantities[0]!.rounding = {
    unit: 'kTokens',
    decimalPlaces: 1,
    mode: 'floor',
  };
  check(f, 'quantity:prompt', 'incomplete');
});
test('dropped claim leaves incomplete report line coverage', () => {
  const f = fixture();
  f.review.claims.pop();
  check(f, 'report-coverage', 'incomplete');
});
test('overlapping coverage is incomplete', () => {
  const f = fixture();
  f.review.nonClaimLines.push({ start: 2, end: 2, reason: 'Duplicate span' });
  check(f, 'report-coverage', 'incomplete');
});
test('dropped citation is incomplete extraction', () => {
  const f = fixture();
  f.review.claims[2]!.citations = [];
  check(f, 'citation-coverage', 'incomplete');
});
test('review of different report bytes is incomplete', () => {
  const f = fixture();
  f.review.reportSha256 = '0'.repeat(64);
  check(f, 'report-identity', 'incomplete');
});
test('unsupported quote fails even if its source exists', () => {
  const f = fixture();
  f.review.claims[2]!.citations[0]!.quote = 'No such result';
  check(f, 'citation:claim-4:0', 'fail');
});
test('uncertain reviewer judgment remains incomplete', () => {
  const f = fixture();
  f.review.claims[0]!.judgment = 'uncertain';
  check(f, 'claim:claim-2', 'incomplete');
});
test('absent mandatory review dimension is incomplete input', () => {
  const f = fixture();
  Reflect.deleteProperty(f.review.dimensions, 'stumbles');
  check(f, 'review-schema', 'incomplete');
});
test('changed historical source remains a failure under incomplete collection', () => {
  const f = fixture();
  f.artifacts.preservation[0]!.status = 'changed';
  f.artifacts.errors.push('historical file changed');
  const result = check(f, 'source-preservation', 'fail', 'incomplete');
  expect(result.checks.find((c) => c.name === 'collection')?.status).toBe(
    'incomplete',
  );
});
test('missing delivered report fails', () => {
  const f = fixture();
  f.artifacts.files = f.artifacts.files.filter(
    (a) => a.originalPath !== f.reportPath,
  );
  check(f, 'report-delivery', 'fail');
});
test('lost child evidence is incomplete', () => {
  const f = fixture();
  rmSync(join(f.runDir, 'atif-sources/analyst-6.json'));
  check(f, 'analyst:cost-and-time:source', 'incomplete');
});
test('lost source index is incomplete', () => {
  const f = fixture();
  rmSync(join(f.runDir, 'atif-sources.json'));
  check(f, 'current-sources', 'incomplete');
});
test('lost required native timestamp is incomplete', () => {
  const f = fixture();
  trajectory(f, 'diagnosis-history/atif-sources/root.json', (t) => {
    delete t.steps[2]!.timestamp;
  });
  check(f, 'quantity:elapsed:evidence', 'incomplete');
});
test('native result timestamp wins over first bundled assistant timestamp', () => {
  const f = fixture();
  trajectory(f, 'diagnosis-history/atif-sources/root.json', (t) => {
    t.steps[1]!.tool_calls = [
      {
        tool_call_id: 'read',
        function_name: 'Read',
        arguments: { path: '/x' },
        extra: native(2),
      },
    ];
    t.steps[1]!.observation = {
      results: [
        {
          source_call_id: 'read',
          content: 'Legitimate reread after changes.',
          extra: native(3, '2026-01-01T00:00:03Z'),
        },
      ],
    };
    t.steps.pop();
  });
  check(f, 'quantity:elapsed:evidence', 'pass');
});
test('wrong case input evidenced by actual dispatch fails', () => {
  const f = fixture();
  trajectory(f, 'atif-sources/controller.json', (t) => {
    t.steps[0]!.tool_calls![0]!.arguments['prompt'] =
      'Read /wrong/case.md /wrong/common.md /wrong/stumbles.md';
  });
  check(f, 'analyst:skill-timeline:inputs', 'fail');
});
test('wrong dimension input fails', () => {
  const f = fixture();
  f.review.analysts[0]!.dimensionPath = f.review.analysts[1]!.dimensionPath;
  check(f, 'analyst:skill-timeline:inputs', 'fail');
});
test('proven unfinished analyst fails', () => {
  const f = fixture();
  f.review.analysts[0]!.completionStepId = null;
  f.review.dimensions['skill-timeline'] = {
    status: 'fail',
    reason: 'Controller stopped this analyst before completion.',
    evidence: [{ source: 'root.jsonl', line: 1 }],
  };
  check(f, 'analyst:skill-timeline:completion', 'fail');
});
test('a tool-call step is not an analyst completion', () => {
  const f = fixture();
  trajectory(f, 'atif-sources/analyst-0.json', (t) => {
    t.steps[1]!.tool_calls = [
      {
        tool_call_id: 'pending',
        function_name: 'Read',
        arguments: { path: '/pending' },
      },
    ];
  });
  check(f, 'analyst:skill-timeline:completion', 'fail');
});
test('collection errors retain all established checks and a partial report', () => {
  const f = fixture();
  f.artifacts.errors.push('capture partly unavailable');
  f.review.targetSessionId = 'wrong';
  const result = check(f, 'target-session', 'fail', 'incomplete');
  expect(result.checks.find((c) => c.name === 'claim:claim-4')?.status).toBe(
    'pass',
  );
});
test('batch call id can be shared by seven distinct linked analyst executions', () => {
  const f = fixture();
  trajectory(f, 'atif-sources/controller.json', (t) => {
    const dispatches = t.steps.slice(0, 7).map((s, index) => ({
      index,
      prompt: s.tool_calls![0]!.arguments['prompt'],
      child: s.tool_calls![0]!.extra!['quorum_child'],
    }));
    t.steps = [
      {
        step_id: 1,
        source: 'agent',
        timestamp: '2026-01-02T00:00:01Z',
        extra: native(1),
        tool_calls: [
          {
            tool_call_id: 'batch',
            function_name: 'Agent',
            arguments: {},
            extra: { ...native(1), quorum_dispatches: dispatches },
          },
        ],
        observation: {
          results: [
            {
              source_call_id: 'batch',
              content: 'Seven completed.',
              extra: { ...native(7), quorum_dispatches: dispatches },
            },
          ],
        },
      },
      { ...t.steps[7]!, step_id: 2 },
    ];
  });
  f.review.analysts.forEach((a, i) => {
    a.dispatchStepId = 1;
    a.callId = 'batch';
    a.batchIndex = i;
  });
  check(f, 'analyst-executions', 'pass');
});
test('opaque prompt uses exact child reads/results, without retained installed-skill copies', () => {
  const f = fixture();
  const a = f.review.analysts[0]!;
  trajectory(f, 'atif-sources/controller.json', (t) => {
    t.steps[0]!.tool_calls![0]!.arguments = {};
  });
  trajectory(f, 'atif-sources/analyst-0.json', (t) => {
    t.steps[0]!.message = 'Encrypted routing';
    t.steps[0] = {
      step_id: 1,
      source: 'agent',
      timestamp: '2026-01-02T00:00:02Z',
      extra: native(1),
      tool_calls: [a.casePath, a.commonPath, a.dimensionPath].map(
        (path, i) => ({
          tool_call_id: `read-${i}`,
          function_name: 'Read',
          arguments: { file_path: path },
          extra: native(1),
        }),
      ),
      observation: {
        results: [0, 1, 2].map((i) => ({
          source_call_id: `read-${i}`,
          content: `Actual file content ${i}`,
          extra: native(1),
        })),
      },
    };
  });
  f.artifacts.files = f.artifacts.files.filter(
    (row) => ![a.commonPath, a.dimensionPath].includes(row.originalPath),
  );
  const result = check(f, 'analyst:skill-timeline:inputs', 'pass');
  expect(
    result.checks.find((c) => c.name === 'analyst:skill-timeline:inputs')
      ?.detail,
  ).toContain('prompt unavailable');
});

test('rounding cannot invent a coarser quantum absent from report display', () => {
  const f = fixture();
  f.review.quantities[0]!.value = 1000;
  f.review.quantities[0]!.rounding = {
    unit: 'kTokens',
    decimalPlaces: 0,
    mode: 'nearest',
  };
  check(f, 'quantity:prompt:display', 'incomplete');
});
test('lost priced token evidence remains incomplete even if assistant text survived', () => {
  const f = fixture();
  trajectory(f, 'diagnosis-history/atif-sources/root.json', (t) => {
    delete t.steps[1]!.metrics;
  });
  check(f, 'quantity:prompt:evidence', 'incomplete');
});
test('unknown opaque inputs remain incomplete when trace cannot establish consumption', () => {
  const f = fixture();
  trajectory(f, 'atif-sources/controller.json', (t) => {
    t.steps[0]!.tool_calls![0]!.arguments = {};
  });
  check(f, 'analyst:skill-timeline:inputs', 'incomplete');
});
test('source aliases do not turn one session into seven analyst executions', () => {
  const f = fixture();
  trajectory(f, 'atif-sources/analyst-6.json', (t) => {
    t.session_id = 'new-0';
  });
  check(f, 'analyst-executions', 'fail');
});
test('a child final claim does not prove the controller delivered the report', () => {
  const f = fixture();
  trajectory(f, 'atif-sources/controller.json', (t) => {
    t.steps[7]!.message = 'Stopped.';
  });
  trajectory(f, 'atif-sources/analyst-0.json', (t) => {
    t.steps[1]!.message = `Saved ${f.reportPath}`;
  });
  check(f, 'report-delivery', 'fail');
});

test('real Claude sidechains distinguish seven current executions and dispatch links', () => {
  const f = fixture();
  currentClaudeSidechains(f);
  const result = check(f, 'analyst-executions', 'pass');
  expect(
    result.checks
      .filter((c) => c.name.endsWith(':dispatch'))
      .map((c) => c.status),
  ).toEqual(Array(7).fill('pass'));
});
test('real Claude duplicate sidechains cannot count as seven current executions', () => {
  const f = fixture();
  currentClaudeSidechains(f, true);
  check(f, 'analyst-executions', 'fail');
});
test('Codex named child relationship requires its native agent metadata and exact parent thread', () => {
  const f = fixture();
  trajectory(f, 'atif-sources/analyst-0.json', (t) => {
    t.agent.name = 'codex';
    t.agent.extra = {
      agent_path: '/root/analyst_0',
      parent_thread_id: 'new-controller',
      parent_session_id: 'new-controller',
    };
  });
  trajectory(f, 'atif-sources/controller.json', (t) => {
    t.steps[0]!.tool_calls![0]!.extra!['quorum_child'] = {
      relationship: 'unknown',
      name: '/root/analyst_0',
    };
  });
  check(f, 'analyst:skill-timeline:dispatch', 'pass');
});
test('real historical Claude sidechain resolves the native child id separately from current analysts', () => {
  const f = fixture();
  currentClaudeSidechains(f);
  claudeSidechain(
    f,
    'diagnosis-history/atif-sources/child.json',
    'old-root',
    'old-child',
  );
  check(f, 'session:old-child:evidence', 'pass');
});

test('missing result timestamp cannot borrow the earlier bundled assistant time', () => {
  const f = fixture();
  trajectory(f, 'diagnosis-history/atif-sources/root.json', (t) => {
    t.steps[1]!.tool_calls = [
      {
        tool_call_id: 'read',
        function_name: 'Read',
        arguments: { path: '/x' },
        extra: native(2),
      },
    ];
    t.steps[1]!.observation = {
      results: [
        {
          source_call_id: 'read',
          content: 'Legitimate reread after changes.',
          extra: native(3),
        },
      ],
    };
    t.steps.pop();
  });
  check(f, 'quantity:elapsed:evidence', 'incomplete');
});
test('frozen cumulative quantities can cite source-mapped final metrics without repricing', () => {
  const f = fixture();
  trajectory(f, 'diagnosis-history/atif-sources/root.json', (t) => {
    delete t.steps[1]!.metrics;
    t.final_metrics = {
      total_prompt_tokens: 1249,
      total_completion_tokens: 10,
      extra: native(2, '2026-01-01T00:00:01Z'),
    };
  });
  check(f, 'quantity:prompt:evidence', 'pass');
});
test('a failed read does not prove opaque analyst input consumption', () => {
  const f = fixture();
  const a = f.review.analysts[0]!;
  trajectory(f, 'atif-sources/controller.json', (t) => {
    t.steps[0]!.tool_calls![0]!.arguments = {};
  });
  trajectory(f, 'atif-sources/analyst-0.json', (t) => {
    t.steps[0] = {
      step_id: 1,
      source: 'agent',
      tool_calls: [a.casePath, a.commonPath, a.dimensionPath].map(
        (path, i) => ({
          tool_call_id: `read-${i}`,
          function_name: 'Read',
          arguments: { path },
          extra: native(1),
        }),
      ),
      observation: {
        results: [0, 1, 2].map((i) => ({
          source_call_id: `read-${i}`,
          content: '[error] file does not exist',
          extra: native(1),
        })),
      },
    };
  });
  check(f, 'analyst:skill-timeline:inputs', 'incomplete');
});

test('relocated current native logs resolve only through the exact authenticated original store root', () => {
  const f = fixture();
  for (const source of f.current.sources) {
    const row = f.artifacts.files.find(
      (a) => a.originalPath === source.nativePath,
    )!;
    const bytes = readFileSync(join(f.runDir, row.retainedPath));
    const relativePath = source.nativePath.slice(
      '/synthetic/home/sessions/'.length,
    );
    f.file(
      `/temporary/${source.id}`,
      `home/.pi/agent/sessions/${relativePath}`,
      bytes.toString(),
    );
    f.artifacts.files = f.artifacts.files.filter(
      (a) =>
        a.originalPath !== source.nativePath &&
        a.originalPath !== `/temporary/${source.id}`,
    );
  }
  check(f, 'analyst:skill-timeline:source', 'pass');
});
test('workflow safety judgments require retained current-run evidence', () => {
  const f = fixture();
  f.review.rubric.exposure.evidence = [{ source: 'root.jsonl', line: 1 }];
  check(f, 'rubric:exposure:evidence', 'incomplete');
});

for (const kind of NATIVE_RESULT_CASES)
  test(`${kind} native failed read cannot establish opaque input consumption`, () => {
    const f = fixture();
    const a = f.review.analysts[0]!;
    trajectory(f, 'atif-sources/controller.json', (t) => {
      t.steps[0]!.tool_calls![0]!.arguments = {};
    });
    trajectory(f, 'atif-sources/analyst-0.json', (t) => {
      const reads = [a.casePath, a.commonPath, a.dimensionPath].map(
        (path) => nativeReadResult(kind, path, true).steps[0]!,
      );
      t.steps = [
        ...reads.map((step, i) => ({ ...step, step_id: i + 1 })),
        { ...t.steps[1]!, step_id: 4 },
      ];
    });
    a.completionStepId = 4;
    check(f, 'analyst:skill-timeline:inputs', 'incomplete');
  });

for (const kind of NATIVE_RESULT_CASES)
  test(`${kind} successful native reads still establish opaque input consumption`, () => {
    const f = fixture();
    const a = f.review.analysts[0]!;
    trajectory(f, 'atif-sources/controller.json', (t) => {
      t.steps[0]!.tool_calls![0]!.arguments = {};
    });
    trajectory(f, 'atif-sources/analyst-0.json', (t) => {
      const reads = [a.casePath, a.commonPath, a.dimensionPath].map(
        (path) => nativeReadResult(kind, path, false).steps[0]!,
      );
      t.steps = [
        ...reads.map((step, i) => ({ ...step, step_id: i + 1 })),
        { ...t.steps[1]!, step_id: 4 },
      ];
    });
    a.completionStepId = 4;
    check(f, 'analyst:skill-timeline:inputs', 'pass');
  });
test('older Pi ATIF appended failure marker cannot establish opaque reads without typed metadata', () => {
  const f = fixture();
  const a = f.review.analysts[0]!;
  trajectory(f, 'atif-sources/controller.json', (t) => {
    t.steps[0]!.tool_calls![0]!.arguments = {};
  });
  trajectory(f, 'atif-sources/analyst-0.json', (t) => {
    const reads = [a.casePath, a.commonPath, a.dimensionPath].map(
      (path) => nativeReadResult('pi', path, true).steps[0]!,
    );
    for (const step of reads)
      delete step.observation!.results[0]!.extra!['quorum_result'];
    t.steps = [
      ...reads.map((step, i) => ({ ...step, step_id: i + 1 })),
      { ...t.steps[1]!, step_id: 4 },
    ];
  });
  a.completionStepId = 4;
  check(f, 'analyst:skill-timeline:inputs', 'incomplete');
});

function reportedDurationFixture(
  measurement: 'native-duration' | 'elapsed-time' = 'native-duration',
) {
  const f = fixture();
  const q = f.key.quantities[2]!;
  const observation = f.review.quantities[2]!;
  q.value = 4321;
  q.scope = 'native reported completed-turn duration';
  q.evidence = [{ source: 'root.jsonl', line: 3 }];
  q.measurement = measurement;
  observation.value = 4321;
  observation.scope = q.scope;
  report(
    f,
    'Elapsed root window: 3000 ms.',
    'Native reported completed-turn duration: 4321 ms.',
  );
  return f;
}
for (const harness of ['claude', 'codex'] as const)
  test(`${harness} native duration counter needs no timestamp`, () => {
    const f = reportedDurationFixture();
    const t = nativeDurationBoundary(harness, 4321);
    trajectory(f, 'diagnosis-history/atif-sources/root.json', (historical) => {
      delete historical.steps[2]!.timestamp;
      historical.extra = t.extra!;
    });
    check(f, 'quantity:elapsed:evidence', 'pass');
  });
for (const harness of ['claude', 'codex'] as const)
  test(`${harness} timestamp cannot substitute for a lost native duration counter`, () => {
    const f = reportedDurationFixture();
    const t = nativeDurationBoundary(
      harness,
      undefined,
      '2026-01-01T00:00:03Z',
    );
    trajectory(f, 'diagnosis-history/atif-sources/root.json', (historical) => {
      historical.extra = t.extra!;
    });
    check(f, 'quantity:elapsed:evidence', 'incomplete');
  });
test('wrong native counter does not qualify the frozen literal measurement', () => {
  const f = reportedDurationFixture();
  const t = nativeDurationBoundary('claude', 9999, '2026-01-01T00:00:03Z');
  trajectory(f, 'diagnosis-history/atif-sources/root.json', (historical) => {
    historical.extra = t.extra!;
  });
  check(f, 'quantity:elapsed:evidence', 'incomplete');
});
test('native duration cannot substitute for missing elapsed endpoint timestamps', () => {
  const f = fixture();
  const t = nativeDurationBoundary('claude', 3000);
  trajectory(f, 'diagnosis-history/atif-sources/root.json', (historical) => {
    delete historical.steps[2]!.timestamp;
    historical.extra = t.extra!;
  });
  check(f, 'quantity:elapsed:evidence', 'incomplete');
});

test('millisecond key convention is explicit on each entry and alternative', () => {
  const f = fixture();
  expect(DiagnosisKeySchema.safeParse(f.key).success).toBe(true);
  const q = f.key.quantities[2]!;
  delete q.measurement;
  expect(DiagnosisKeySchema.safeParse(f.key).success).toBe(false);
  q.measurement = 'elapsed-time';
  q.alternatives = [
    {
      value: 4321,
      scope: 'native reported runtime',
      evidence: [{ source: 'root.jsonl', line: 3 }],
    },
  ];
  expect(DiagnosisKeySchema.safeParse(f.key).success).toBe(false);
  q.alternatives[0]!.measurement = 'native-duration';
  expect(DiagnosisKeySchema.safeParse(f.key).success).toBe(true);
  f.key.quantities[0]!.measurement = 'native-duration';
  expect(DiagnosisKeySchema.safeParse(f.key).success).toBe(false);
});

for (const harness of ['claude', 'pi'] as const)
  test(`${harness} source-mapped singleton wrapper duration qualifies without timestamps`, () => {
    const f = reportedDurationFixture();
    const counter = nativeDurationResult(harness, 4321).steps[0]!;
    trajectory(f, 'diagnosis-history/atif-sources/root.json', (t) => {
      t.steps[2] = {
        ...counter,
        step_id: 3,
        message: 'Legitimate reread after changes.',
        extra: native(3),
      };
    });
    check(f, 'quantity:elapsed:evidence', 'pass');
  });
for (const harness of ['claude', 'pi'] as const)
  test(`${harness} retained wrapper text cannot replace a lost typed counter`, () => {
    const f = reportedDurationFixture();
    const counter = nativeDurationResult(harness, 4321).steps[0]!;
    delete counter.observation!.results[0]!.extra!['quorum_result'];
    trajectory(f, 'diagnosis-history/atif-sources/root.json', (t) => {
      t.steps[2] = {
        ...counter,
        step_id: 3,
        timestamp: '2026-01-01T00:00:03Z',
        message: 'Legitimate reread after changes.',
        extra: native(3),
      };
    });
    check(f, 'quantity:elapsed:evidence', 'incomplete');
  });
test('duration alternatives select their own explicit native convention', () => {
  const f = fixture();
  const q = f.key.quantities[2]!;
  q.alternatives = [
    {
      value: 4321,
      scope: 'native reported runtime',
      measurement: 'native-duration',
      evidence: [{ source: 'root.jsonl', line: 3 }],
    },
  ];
  f.review.quantities[2]!.value = 4321;
  f.review.quantities[2]!.scope = 'native reported runtime';
  report(
    f,
    'Elapsed root window: 3000 ms.',
    'Native reported runtime: 4321 ms.',
  );
  trajectory(f, 'diagnosis-history/atif-sources/root.json', (t) => {
    delete t.steps[2]!.timestamp;
    t.extra = nativeDurationBoundary('claude', 4321).extra!;
  });
  check(f, 'quantity:elapsed:evidence', 'pass');
});

for (const variant of [
  'success',
  'mixed-failure',
  'missing',
  'missing-status',
  'empty',
  'ambiguous',
  'unrelated',
  'unmapped-first',
] as const)
  test(`real Codex composite opaque input reads: ${variant}`, () => {
    const f = fixture();
    const a = f.review.analysts[0]!;
    const paths = [a.casePath, a.commonPath, a.dimensionPath];
    const statements = paths.map(
      (path) =>
        `text(await tools.exec_command({cmd: ${JSON.stringify(`cat ${path}`)}}));`,
    );
    const input =
      variant === 'ambiguous'
        ? statements
            .map((statement) => `if (unknown) { ${statement} }`)
            .join('\n')
        : statements.join('\n');
    const outcomes = paths.map((path, i) => ({
      type: 'input_text',
      text: JSON.stringify({
        ...(variant === 'missing-status' && i === 1
          ? {}
          : { exit_code: variant === 'mixed-failure' && i === 1 ? 1 : 0 }),
        output:
          variant === 'empty' && i === 1
            ? ''
            : variant === 'mixed-failure' && i === 1
              ? 'ENOENT: file not found'
              : `Contents of ${path}`,
        wall_time_seconds: 0.01,
      }),
    }));
    if (variant === 'missing') outcomes.splice(1, 1);
    const payloads = [
      { type: 'custom_tool_call', name: 'exec', call_id: 'reads', input },
      {
        type: 'custom_tool_call_output',
        call_id: variant === 'unrelated' ? 'other' : 'reads',
        output: [
          {
            type: 'input_text',
            text: 'Script completed\nWall time 0.1 seconds\nOutput:\n',
          },
          ...outcomes,
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Completed synthetic analysis.' },
        ],
      },
    ];
    // A single logical shell call can mention all inputs. Unknown output mapping
    // must not gain admission just because its id equals the physical call id.
    if (variant === 'unmapped-first')
      payloads[0]!.input = `if (unknown) { text(await tools.exec_command({cmd: ${JSON.stringify(`cat ${paths.join(' ')}`)}})); }`;
    const raw = [
      { type: 'session_meta', payload: { id: 'new-0' } },
      ...payloads.map((payload) => ({ type: 'response_item', payload })),
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');
    trajectory(f, 'atif-sources/controller.json', (t) => {
      t.steps[0]!.tool_calls![0]!.arguments = {};
    });
    nativeSource(f, 'atif-sources/analyst-0.json', raw, normalizeCodex);
    a.completionStepId = variant === 'unrelated' ? 3 : 2;
    check(
      f,
      'analyst:skill-timeline:inputs',
      variant === 'success' ? 'pass' : 'incomplete',
    );
  });
