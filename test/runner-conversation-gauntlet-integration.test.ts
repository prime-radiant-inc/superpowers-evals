// Cross-repository wire qualification: actual Gauntlet CLI processes and tmux,
// with a localhost-only Anthropic transport supplying finite scripted replies.
import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { readCommittedPrefix } from '../src/campaign/execution-journal.ts';
import { foldComparisonReport } from '../src/campaign/report.ts';
import {
  deliverComparisonReport,
  readReportDelivery,
} from '../src/campaign/report-delivery.ts';
import { readAttemptEvidence } from '../src/campaign/report-evidence.ts';
import { readComparisonReadout } from '../src/campaign/report-publication.ts';
import { snapshotDir } from '../src/capture/index.ts';
import { GauntletRolesSchema } from '../src/contracts/conversation.ts';
import type { FinalVerdict } from '../src/contracts/verdict.ts';
import type { RunEconomics } from '../src/economics.ts';
import { getEnv } from '../src/env.ts';
import { runPreparedConversation } from '../src/runner/conversation.ts';
import { verifyAssessmentAccounting } from '../src/runner/role-usage.ts';
import {
  AssessmentFixtureEvidence,
  DeferredResponses,
} from './assessment-wire-fixture.ts';
import { twoArmExperiment } from './fixtures/core-comparison/factory.ts';
import {
  completedPublicationFixture,
  finishPublicationFixture,
} from './fixtures/core-comparison/publication.ts';

function verifyPublishedFailure(
  runDir: string,
  verdict: FinalVerdict,
  mode: string,
) {
  const experiment = twoArmExperiment();
  experiment.measurement_requirements = {
    scenario: {
      mode: 'conversation',
      story_sha256: 'a'.repeat(64),
      rubric_sha256: 'b'.repeat(64),
      check_manifest_sha256: 'c'.repeat(64),
      checks: verdict.checks.map((check, ordinal) => ({
        ordinal,
        phase: check.phase!,
        check: check.check,
        args: check.args,
        negated: check.negated,
        count: 1,
        authority: { kind: 'output_check' as const, sources: ['oracle.cjs'] },
      })),
      criteria: [
        {
          id: 'scenario:1',
          ordinal: 1,
          text: 'Fix pricing',
          required_artifact_classes: ['normalized_trace', 'output'],
          check_refs: [],
        },
      ],
    },
  };
  const f = completedPublicationFixture(
    'primary',
    experiment,
    undefined,
    (target, identity) => {
      for (const path of [
        'conversation-agent',
        'gauntlet-agent',
        'evidence',
        'conversation.json',
        'gauntlet-roles.json',
        'trajectory.json',
        'coding-agent-token-usage.json',
      ]) {
        if (
          existsSync(join(runDir, path)) &&
          !(mode === 'trace-unavailable' && path === 'trajectory.json')
        )
          cpSync(join(runDir, path), join(target, path), { recursive: true });
      }
      writeFileSync(
        join(target, 'verdict.json'),
        JSON.stringify({
          ...verdict,
          campaign:
            mode === 'source-mismatch'
              ? { ...identity, sample_id: 'other-source' }
              : identity,
        }),
      );
    },
  );
  try {
    const processes = { observe: () => 'dead' as const };
    const active = readComparisonReadout(f, { observe: () => 'live' as const });
    expect(active.report.behavior_available).toBe(false);
    expect(active.report.comparisons).toEqual([]);
    expect(() =>
      deliverComparisonReport({
        ...f,
        processes: { observe: () => 'live' as const },
        now: Date.now,
      }),
    ).toThrow('behavioral report unavailable');
    finishPublicationFixture(f);
    const state = readCommittedPrefix(f.campaignDir).projection;
    const evidenceByAttempt = new Map(
      [...state.attempts.values()].map((a) => [
        a.intent.identity.execution_attempt_id,
        readAttemptEvidence({
          resultsRoot: f.resultsRoot,
          expectedIdentity: a.intent.identity,
          artifacts: a.observation!.artifacts,
        }),
      ]),
    );
    const folded = foldComparisonReport({
      experiment: f.experiment,
      state,
      evidenceByAttempt,
      validityByBlock: new Map([['primary', { available: true, reasons: [] }]]),
    });
    const delivered = deliverComparisonReport({
      ...f,
      processes,
      now: Date.now,
    });
    expect(delivered.report.report.comparisons).toEqual(folded.comparisons);
    for (const arm of folded.comparisons[0]!.arms) {
      const m = arm.measurements;
      for (const obligation of [m.interaction, ...m.checks, ...m.criteria])
        expect(
          obligation.pass +
            obligation.fail +
            obligation.unclear +
            obligation.unavailable,
        ).toBe(obligation.planned);
      expect(m.interaction.pass).toBe(mode === 'source-mismatch' ? 0 : 1);
      const accepted = [
        'reserve',
        'retry',
        'checker-missing',
        'checker-crash',
        'check-fail',
      ].includes(mode);
      expect(m.criteria[0]!.pass).toBe(accepted ? 1 : 0);
      expect(m.criteria[0]!.unavailable).toBe(accepted ? 0 : 1);
      expect(m.checks[0]!.fail).toBe(mode === 'check-fail' ? 1 : 0);
      expect(m.checks[0]!.unavailable).toBe(
        ['checker-missing', 'checker-crash', 'source-mismatch'].includes(mode)
          ? 1
          : 0,
      );
    }
    expect(folded.accounting.grader_cost_usd.attempts).toBe(2);
    if (mode === 'retry') {
      expect(folded.accounting.grader_cost_usd.known_subtotal).toBeGreaterThan(
        0,
      );
      expect(folded.accounting.grader_cost_usd.complete).toBe(false);
    }
    const criterionReady = delivered.delivery.measurement_readiness.filter(
      (r) => r.kind === 'criterion',
    );
    expect(criterionReady.every((r) => r.complete)).toBe(
      [
        'reserve',
        'retry',
        'checker-missing',
        'checker-crash',
        'check-fail',
      ].includes(mode),
    );
    expect(readReportDelivery(delivered.report)).toEqual(delivered.delivery);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

const gauntletRoot = getEnv('GAUNTLET_ROOT');
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

type Message = {
  role: string;
  content: string | { type: string; content?: string; text?: string }[];
};
type Request = {
  tools: { name: string }[];
  messages: Message[];
  model: string;
};
function resultTexts(request: Request): string[] {
  return request.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content
          .filter((block) => block.type === 'tool_result')
          .map((block) => block.content ?? '')
      : [],
  );
}

for (const interruption of ['cancelled', 'timed_out'] as const)
  test.skipIf(!gauntletRoot)(
    'retains visible Claude startup evidence when the outer role is ' +
      interruption,
    async () => {
      const runDir = mkdtempSync(join(tmpdir(), 'wire-startup-'));
      const workdir = join(runDir, 'work');
      const scenarioDir = join(runDir, 'scenario');
      const home = join(runDir, 'home');
      const logs = join(home, 'logs');
      for (const path of [workdir, scenarioDir, logs])
        mkdirSync(path, { recursive: true });
      let providerRequests = 0;
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch() {
          providerRequests++;
          return new Response('startup barrier called provider', {
            status: 500,
          });
        },
      });
      try {
        writeFileSync(
          join(scenarioDir, 'story.md'),
          '---\nid: wire-startup\ntitle: Startup interruption\nstatus: ready\nquorum_mode: conversation\nquorum_max_time: 10m\n---\nPlease fix pricing.\n\n## Acceptance Criteria\n- Pricing returns 42.\n',
        );
        writeFileSync(join(scenarioDir, 'oracle.cjs'), 'process.exit(1);\n');
        writeFileSync(
          join(scenarioDir, 'checks.sh'),
          'pre() { :; }\npost() { :; }\n',
        );
        const subjectPid = join(runDir, 'subject-pid');
        const subject = join(runDir, 'subject.ts');
        writeFileSync(
          subject,
          "import { writeFileSync } from 'node:fs';\n" +
            'writeFileSync(' +
            JSON.stringify(subjectPid) +
            ', String(process.pid));\n' +
            "process.stdout.write('\\u001b[1mClaude Code v2.1.209\\u001b[0m\\n\\u001b[33mTrust this folder\\u001b[0m\\n\\u001b[38;5;111m❯ 2. No\\u001b[0m\\n');\n" +
            'await new Promise(() => {});\n',
        );
        const launcher = join(workdir, 'launch-agent.sh');
        writeFileSync(
          launcher,
          '#!/bin/sh\nexec ' +
            shellQuote(process.execPath) +
            ' ' +
            shellQuote(subject) +
            '\n',
        );
        chmodSync(launcher, 0o755);
        const gauntlet = join(runDir, 'gauntlet');
        writeFileSync(
          gauntlet,
          '#!/bin/sh\nexec ' +
            shellQuote(process.execPath) +
            ' ' +
            shellQuote(join(gauntletRoot!, 'src/index.ts')) +
            ' "$@"\n',
        );
        chmodSync(gauntlet, 0o755);

        const startupWasCaptured = () => {
          try {
            const roles = GauntletRolesSchema.parse(
              JSON.parse(
                readFileSync(join(runDir, 'gauntlet-roles.json'), 'utf8'),
              ),
            );
            const exchange = join(
              runDir,
              roles.conversation.out_dir,
              'exchange.jsonl',
            );
            return (
              existsSync(exchange) &&
              readFileSync(exchange, 'utf8').includes('"kind":"startup"')
            );
          } catch {
            return false;
          }
        };
        const verdict = await runPreparedConversation({
          runDir,
          scenarioDir,
          storyPath: join(scenarioDir, 'story.md'),
          launcherPath: launcher,
          workdir,
          launchCwd: workdir,
          runHomeDir: home,
          configDir: home,
          codingAgent: 'claude',
          normalizer: 'claude',
          logDir: logs,
          logGlob: '*.jsonl',
          snapshot: snapshotDir(logs, '*.jsonl'),
          checksSh: join(scenarioDir, 'checks.sh'),
          checksRepoRoot: resolve(import.meta.dir, '..'),
          preRecords: [],
          expectedChecks: null,
          gauntletBin: gauntlet,
          graderModel: 'claude-sonnet-4-6',
          assessmentBudget: { totalMs: 600000, reportGraceMs: 60000 },
          maxTime: '5s',
          envBase: {
            HOME: home,
            PATH: getEnv('PATH'),
            ANTHROPIC_API_KEY: 'offline-only',
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
          },
          shouldStop:
            interruption === 'cancelled' ? startupWasCaptured : () => false,
          identity: {
            scenario: 'wire-startup',
            agent: 'claude',
            credential: 'offline',
            os: 'linux',
          },
        });

        expect(providerRequests).toBe(0);
        expect(verdict.conversation).toMatchObject({
          status: interruption === 'cancelled' ? 'stopped' : 'timed_out',
          endpoint: null,
          evidence: { quote: '❯ 2. No' },
        });
        const visible = verdict.conversation?.evidence;
        expect(visible).not.toBeNull();
        expect(existsSync(join(runDir, visible!.path))).toBe(true);
        const retained = JSON.parse(
          readFileSync(join(runDir, 'evidence/conversation.json'), 'utf8'),
        );
        expect(retained.evidence.path).toMatch(/^visible\/captures\//);
        expect(
          existsSync(join(runDir, 'evidence', retained.evidence.path)),
        ).toBe(true);
        const roles = GauntletRolesSchema.parse(
          JSON.parse(readFileSync(join(runDir, 'gauntlet-roles.json'), 'utf8')),
        );
        expect(roles.conversation.stop_cause).toBe(interruption);
        const pid = Number(readFileSync(subjectPid, 'utf8'));
        expect(() => process.kill(-pid, 0)).toThrow();
      } finally {
        await server.stop(true);
        rmSync(runDir, { recursive: true, force: true });
      }
    },
    15_000,
  );

for (const outcome of [
  'correct',
  'incorrect',
  'refusal',
  'mixed-unclear',
  'investigate-unclear',
] as const)
  test.skipIf(!gauntletRoot)(
    `Quorum role argv drives actual Gauntlet terminal and independent assessment: ${outcome}`,
    async () => {
      const runDir = mkdtempSync(join(tmpdir(), 'wire-'));
      const workdir = join(runDir, 'work');
      const scenarioDir = join(runDir, 'scenario');
      const home = join(runDir, 'home');
      const logs = join(home, 'logs');
      for (const path of [workdir, scenarioDir, logs])
        mkdirSync(path, { recursive: true });
      const requests: {
        role: 'conversation' | 'assessment';
        request: Request;
      }[] = [];
      const failures: string[] = [];
      let conversationTurns = 0;
      let assessmentTurns = 0;
      let answered = false;
      let sawQuestion = false;
      let conversationRequestsBeforeReady = 0;
      let assessedOutput = '';
      const unclear =
        outcome === 'mixed-unclear' || outcome === 'investigate-unclear';
      const expectedStatus =
        outcome === 'correct'
          ? 'pass'
          : outcome === 'investigate-unclear'
            ? 'investigate'
            : 'fail';
      const endpoint = outcome === 'refusal' ? 'refusal' : 'delivery';
      const finalQuote =
        outcome === 'refusal'
          ? 'I refuse to change pricing.'
          : 'Delivered pricing.js.';
      const readyMarker = join(runDir, 'subject-ready');
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(httpRequest) {
          if (new URL(httpRequest.url).pathname !== '/v1/messages')
            return new Response('Unexpected path', { status: 400 });
          const request = (await httpRequest.json()) as Request;
          const isConversation = request.tools.some(
            (tool) => tool.name === 'finish_conversation',
          );
          requests.push({
            role: isConversation ? 'conversation' : 'assessment',
            request,
          });
          let name: string;
          let input: Record<string, unknown>;
          try {
            if (isConversation) {
              if (!existsSync(readyMarker)) conversationRequestsBeforeReady++;
              if (++conversationTurns > 20)
                throw new Error(
                  'conversation exhausted scripted response bound',
                );
              let screen: { capture: string; screen: string } | undefined;
              for (const text of resultTexts(request)) {
                try {
                  const value = JSON.parse(text);
                  if (typeof value.screen === 'string') screen = value;
                } catch {
                  /* Ordinary terminal acknowledgments are not captures. */
                }
              }
              if (screen?.screen.includes('Which currency?') && !answered) {
                sawQuestion = true;
                answered = true;
                name = 'type_and_submit';
                input = { text: 'USD' };
              } else if (screen?.screen.includes(finalQuote)) {
                name = 'finish_conversation';
                input = {
                  endpoint,
                  reason: 'Visible subject endpoint',
                  capture: screen.capture,
                  quote: finalQuote,
                };
              } else {
                name = 'read_screen';
                input = {};
                await Bun.sleep(30);
              }
            } else {
              if (++assessmentTurns > 3)
                throw new Error('assessment exhausted scripted response bound');
              if (assessmentTurns === 1) {
                name = 'read_evidence';
                input = { path: 'output/pricing.js' };
              } else {
                assessedOutput = resultTexts(request).at(-1) ?? '';
                const status =
                  outcome === 'investigate-unclear'
                    ? 'investigate'
                    : assessedOutput.includes('return 42')
                      ? 'pass'
                      : 'fail';
                name = 'report_result';
                input = {
                  summary: 'Retained pricing inspected',
                  reasoning: 'Assessment read output/pricing.js',
                  criteria: [
                    {
                      verdict: status === 'investigate' ? 'unclear' : status,
                      observation: assessedOutput,
                      basis:
                        'The exported return value directly determines the pricing criterion.',
                      limitations:
                        'Only the retained pricing implementation was inspected.',
                      references: ['output/pricing.js'],
                    },
                    ...(unclear
                      ? [
                          {
                            verdict: 'unclear',
                            observation:
                              'The retained pricing implementation does not record delivery verification.',
                            basis:
                              'The available file is insufficient to establish delivery.',
                            limitations:
                              'No separate retained delivery record was available.',
                            references: ['output/pricing.js'],
                          },
                        ]
                      : []),
                  ],
                };
              }
            }
            return Response.json({
              id: `msg-${requests.length}`,
              type: 'message',
              role: 'assistant',
              model: request.model,
              content: [
                {
                  type: 'tool_use',
                  id: `tool-${requests.length}`,
                  name,
                  input,
                },
              ],
              stop_reason: 'tool_use',
              stop_sequence: null,
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_creation_input_tokens: 2,
                cache_read_input_tokens: 3,
              },
            });
          } catch (error) {
            failures.push(String(error));
            return Response.json(
              {
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  message: String(error),
                },
              },
              { status: 400 },
            );
          }
        },
      });
      try {
        writeFileSync(
          join(scenarioDir, 'story.md'),
          `---\nid: wire-pricing\ntitle: Pricing conversation\nstatus: ready\nquorum_mode: conversation\nquorum_max_time: 10m\n---\nPlease fix pricing for my shop.\n\n## Acceptance Criteria\n- Pricing returns 42.\n${unclear ? '- Delivery is verified.\n' : ''}`,
        );
        writeFileSync(
          join(workdir, 'pricing.js'),
          'module.exports = () => { return 0; };\n',
        );
        writeFileSync(
          join(scenarioDir, 'oracle.cjs'),
          "process.exit(require(process.cwd() + '/pricing.js')() === 42 ? 0 : 1);\n",
        );
        writeFileSync(
          join(scenarioDir, 'checks.sh'),
          `pre() { :; }\npost() { command-succeeds ${shellQuote(`node ${shellQuote(join(scenarioDir, 'oracle.cjs'))}`)}; }\n`,
        );
        const subject = join(runDir, 'subject.ts');
        writeFileSync(
          subject,
          `import { writeFileSync } from 'node:fs';
await Bun.sleep(200);
process.stdout.write('\u001b[1;38;5;111m');
process.stdout.write('╭─── Claude Code v2.1.209 ───╮\\n❯  \\n⏵⏵ bypass permissions on (shift+tab to cycle)\\nWhich currency?\\n');
process.stdout.write('\u001b[0m');
writeFileSync(${JSON.stringify(readyMarker)}, 'ready');
for await (const chunk of Bun.stdin.stream()) {
  const answer = new TextDecoder().decode(chunk).trim();
  if (answer !== 'USD') process.exit(8);
  writeFileSync(${JSON.stringify(join(runDir, 'answer.txt'))}, answer);
  ${outcome === 'refusal' ? '' : `writeFileSync('pricing.js', ${JSON.stringify(`module.exports = () => { return ${outcome === 'correct' ? 42 : 7}; };\n`)});`}
  writeFileSync(${JSON.stringify(join(logs, 'native.jsonl'))}, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'subject', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: ${JSON.stringify(finalQuote)} }], usage: { input_tokens: 10, output_tokens: 5 } } }) + '\\n');
  process.stdout.write(${JSON.stringify(`${finalQuote}\n`)});
  break;
}
await new Promise(() => {});
`,
        );
        const launcher = join(workdir, 'launch-agent.sh');
        writeFileSync(
          launcher,
          `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(subject)}\n`,
        );
        chmodSync(launcher, 0o755);
        const gauntlet = join(runDir, 'gauntlet');
        writeFileSync(
          gauntlet,
          `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(gauntletRoot!, 'src/index.ts'))} "$@"\n`,
        );
        chmodSync(gauntlet, 0o755);
        const verdict = await runPreparedConversation({
          runDir,
          scenarioDir,
          storyPath: join(scenarioDir, 'story.md'),
          launcherPath: launcher,
          workdir,
          launchCwd: workdir,
          runHomeDir: home,
          configDir: home,
          codingAgent: 'claude',
          normalizer: 'claude',
          logDir: logs,
          logGlob: '*.jsonl',
          snapshot: snapshotDir(logs, '*.jsonl'),
          checksSh: join(scenarioDir, 'checks.sh'),
          checksRepoRoot: resolve(import.meta.dir, '..'),
          preRecords: [],
          expectedChecks: null,
          gauntletBin: gauntlet,
          graderModel: 'claude-sonnet-4-6',
          assessmentBudget: { totalMs: 600000, reportGraceMs: 60000 },
          maxTime: '20s',
          envBase: {
            HOME: home,
            PATH: getEnv('PATH'),
            ANTHROPIC_API_KEY: 'offline-only',
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
          },
          shouldStop: () => false,
          identity: {
            scenario: 'wire-pricing',
            agent: 'claude',
            credential: 'offline',
            os: 'linux',
          },
        });
        expect(failures).toEqual([]);
        expect(verdict.error).toBeNull();
        expect(verdict.final).toBe(
          expectedStatus === 'investigate' ? 'indeterminate' : expectedStatus,
        );
        expect(verdict.gauntlet?.status).toBe(expectedStatus);
        if (unclear)
          expect(verdict.gauntlet?.criteria?.[1]).toMatchObject({
            criterion: 'Delivery is verified.',
            verdict: 'unclear',
          });
        expect(sawQuestion).toBe(true);
        expect(conversationRequestsBeforeReady).toBe(0);
        expect(readFileSync(join(runDir, 'answer.txt'), 'utf8')).toBe('USD');
        expect(verdict.conversation).toMatchObject({
          status: 'completed',
          endpoint,
          evidence: { quote: finalQuote },
        });
        expect(
          verdict.checks.find((check) => check.phase === 'post')?.passed,
        ).toBe(outcome === 'correct');
        expect(verdict.gauntlet?.criteria?.[0]).toMatchObject({
          criterion: 'Pricing returns 42.',
          verdict:
            outcome === 'investigate-unclear' ? 'unclear' : expectedStatus,
        });
        expect(assessedOutput).toContain(
          `return ${outcome === 'correct' ? 42 : outcome === 'refusal' ? 0 : 7}`,
        );
        expect(verdict.gauntlet?.process_exit?.code).toBe(
          outcome === 'correct' ? 0 : 1,
        );
        const roles = GauntletRolesSchema.parse(
          JSON.parse(readFileSync(join(runDir, 'gauntlet-roles.json'), 'utf8')),
        );
        for (const role of Object.values(roles)) {
          expect(role.started_at).not.toBeNull();
          expect(role.finished_at).not.toBeNull();
          expect(
            readFileSync(
              join(runDir, role.out_dir, 'usage.jsonl'),
              'utf8',
            ).trim(),
          ).not.toBe('');
        }
        const economics = verdict.economics as unknown as RunEconomics;
        expect(
          verifyAssessmentAccounting({
            runJsonl: readFileSync(
              join(runDir, roles.assessment.out_dir, 'run.jsonl'),
              'utf8',
            ),
            usageJsonl: readFileSync(
              join(runDir, roles.assessment.out_dir, 'usage.jsonl'),
              'utf8',
            ),
            attemptsJsonl: readFileSync(
              join(
                runDir,
                roles.assessment.out_dir,
                'assessment-attempts.jsonl',
              ),
              'utf8',
            ),
          }),
        ).toEqual({
          logicalResponses: 2,
          physicalAttempts: 2,
          unknownUsageAttemptIds: [],
        });
        expect(economics.partial).toBe(false);
        expect(economics.gauntlet?.tokens.total).toBe(
          (conversationTurns + assessmentTurns) * 20,
        );
        expect(
          economics.gauntlet?.roles?.conversation.usage?.total_tokens,
        ).toBe(conversationTurns * 20);
        expect(economics.gauntlet?.roles?.assessment.usage?.total_tokens).toBe(
          40,
        );
        expect(economics.total_est_cost_usd).toBeGreaterThan(0);
        const index = JSON.parse(
          readFileSync(join(runDir, 'evidence/index.json'), 'utf8'),
        ).files as string[];
        expect(index).toContain('visible/exchange.jsonl');
        expect(index).toContain('native/native.jsonl');
        expect(index).toContain('output/pricing.js');
        const completion = verdict.conversation!.evidence!;
        expect(completion.path.endsWith('.ansi')).toBe(true);
        expect(
          readFileSync(
            join(runDir, completion.path.replace(/\.ansi$/, '.json')),
            'utf8',
          ),
        ).toContain('cells');
        const assessedCompletion = JSON.parse(
          readFileSync(join(runDir, 'evidence/conversation.json'), 'utf8'),
        );
        expect(
          assessedCompletion.evidence.path.startsWith('visible/captures/'),
        ).toBe(true);
        expect(
          JSON.parse(
            readFileSync(
              join(runDir, roles.assessment.out_dir, 'result.json'),
              'utf8',
            ),
          ).runId,
        ).toBe(basename(roles.assessment.out_dir));
        const firstConversation = requests.find(
          (entry) => entry.role === 'conversation',
        )!.request;
        const firstAssessment = requests.find(
          (entry) => entry.role === 'assessment',
        )!.request;
        expect(JSON.stringify(firstConversation.messages)).not.toContain(
          'Pricing returns 42.',
        );
        expect(JSON.stringify(firstAssessment.messages)).not.toContain(
          'Please fix pricing for my shop.',
        );
        expect(firstAssessment.tools.map((tool) => tool.name).sort()).toEqual([
          'read_evidence',
          'report_result',
          'search_evidence',
        ]);
      } finally {
        await server.stop(true);
        rmSync(runDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

// Lifecycle faults use the ordinary local conversation fixture for setup and
// the actual paired assessment CLI/SDK for the boundary under test.
for (const mode of [
  'reserve',
  'late',
  'timeout',
  'cancel',
  'forced-kill',
  'writer-failure',
  'double-fault',
  'conversion-error',
  'parent-cancel',
  'parent-deadline',
  'retry',
  'checker-missing',
  'checker-crash',
  'check-fail',
  'trace-unavailable',
  'source-mismatch',
] as const)
  test.skipIf(!gauntletRoot)(
    `actual assessment lifecycle and physical costs: ${mode}`,
    async () => {
      const runDir = mkdtempSync(join(tmpdir(), 'assessment-wire-'));
      const evidence = new AssessmentFixtureEvidence(runDir, mode);
      const deferred = new DeferredResponses();
      const workdir = join(runDir, 'work');
      const scenarioDir = join(runDir, 'scenario');
      const logs = join(runDir, 'home/logs');
      for (const dir of [workdir, scenarioDir, logs])
        mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(workdir, 'pricing.js'),
        'module.exports = () => 42;\n',
      );
      writeFileSync(
        join(scenarioDir, 'story.md'),
        '---\nid: demo\ntitle: Offline lifecycle fixture\nstatus: ready\nquorum_mode: conversation\nquorum_max_time: 10m\n---\nFix pricing.\n\n## Acceptance Criteria\n- Fix pricing\n',
      );
      writeFileSync(
        join(scenarioDir, 'oracle.cjs'),
        `process.exit(${mode === 'check-fail' ? 1 : mode === 'checker-crash' ? 127 : 0});\n`,
      );
      writeFileSync(
        join(scenarioDir, 'checks.sh'),
        `pre() { :; }\npost() { command-succeeds ${shellQuote(mode === 'checker-missing' ? '/missing-checker-task8' : `node ${shellQuote(join(scenarioDir, 'oracle.cjs'))}`)}; }\n`,
      );
      writeFileSync(join(runDir, 'fixture-mode'), 'refusal');
      const preload = join(runDir, 'preload.ts');
      writeFileSync(
        preload,
        `
import { spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as writer from ${JSON.stringify(join(gauntletRoot!, 'src/evidence/writer.ts'))};
const mode = ${JSON.stringify(mode)};
const argv = process.argv;
const hard = Number(argv[argv.indexOf('--hard-deadline-at-ms')+1]);
const anchor = hard - 600000;
let time = 0;
let responses = 0;
if (['reserve','late','parent-cancel','parent-deadline','writer-failure','double-fault'].includes(mode)) {
  spyOn(Date,'now').mockImplementation(()=>anchor);
  spyOn(performance,'now').mockImplementation(()=>time);
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await fetch(...args);
    responses++;
    time = response.headers.has('x-report') ? (mode === 'late' ? 595000 : 594999) : (responses === 1 ? 0 : 540000);
    return response;
  };
}
if (mode === 'forced-kill') {
  const on = process.on.bind(process);
  process.on = (signal, listener) => on(signal, signal === 'SIGTERM' ? ()=>{} : listener);
}
const write = writer.writeResultFiles;
spyOn(writer,'writeResultFiles').mockImplementation((dir,result,writeFile)=>{
  time = 597000;
  if (mode === 'parent-cancel') fs.writeFileSync(${JSON.stringify(join(runDir, 'cancel'))}, 'decision');
  return write(dir,result,(path,text)=>{
    if (mode === 'writer-failure' && path.endsWith('result.md')) throw new Error('local storage fixture failure');
    writeFile(path,text);
  });
});
if (mode === 'double-fault') {
  const out = argv[argv.indexOf('--out')+1];
  const sync = fs.fsyncSync;
  spyOn(fs,'fsyncSync').mockImplementation(fd=>{
    if (fs.fstatSync(fd).isDirectory() && fs.existsSync(out+'/assessment-completion.json')) throw new Error('local marker sync failure');
    return sync(fd);
  });
  const unlink = fs.unlinkSync;
  spyOn(fs,'unlinkSync').mockImplementation(path=>{
    if (String(path).endsWith('assessment-completion.json')) throw new Error('local marker rollback failure');
    return unlink(path);
  });
}
`,
      );
      const gauntlet = join(runDir, 'gauntlet');
      // Only the cooperative-timeout fixture shortens the standalone allowance;
      // the inherited parent flag still comes verbatim from quorum.
      // exec keeps the assessment PID owned directly by quorum, including SIGKILL.
      writeFileSync(
        gauntlet,
        `#!/bin/sh\nif [ "$1" = assess ]; then\n${mode === 'timeout' ? `  exec ${shellQuote(process.execPath)} --preload ${shellQuote(preload)} ${shellQuote(join(gauntletRoot!, 'src/index.ts'))} "$@" --max-time 5500ms --report-grace 100ms\n` : `  exec ${shellQuote(process.execPath)} --preload ${shellQuote(preload)} ${shellQuote(join(gauntletRoot!, 'src/index.ts'))} "$@"\n`}fi\nexec ${shellQuote(process.execPath)} ${shellQuote(resolve(import.meta.dir, 'fixtures/conversation-role.ts'))} "$@"\n`,
      );
      chmodSync(gauntlet, 0o755);
      let requests = 0;
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(http) {
          const request = (await http.json()) as Request;
          const index = requests++;
          evidence.phase('assessment-request-received');
          if (['timeout', 'cancel', 'forced-kill'].includes(mode))
            return deferred.response();
          if (mode === 'retry' && index === 0)
            return Response.json(
              {
                type: 'error',
                error: { type: 'rate_limit_error', message: 'fixture retry' },
              },
              { status: 429, headers: { 'retry-after-ms': '1' } },
            );
          const report =
            index >=
            ([
              'reserve',
              'late',
              'parent-cancel',
              'parent-deadline',
              'writer-failure',
              'double-fault',
              'retry',
            ].includes(mode)
              ? 2
              : 1);
          await Bun.sleep(20);
          return Response.json(
            {
              id: `msg-${index}`,
              type: 'message',
              role: 'assistant',
              model: request.model,
              content:
                mode === 'conversion-error'
                  ? null
                  : [
                      {
                        type: 'tool_use',
                        id: `tool-${index}`,
                        name: report ? 'report_result' : 'read_evidence',
                        input: report
                          ? {
                              summary: 'Inspected output',
                              reasoning: 'Read retained output',
                              criteria: [
                                {
                                  verdict:
                                    mode === 'double-fault' ? 'fail' : 'pass',
                                  observation: 'The file exports 42.',
                                  basis:
                                    'Direct observation of implementation.',
                                  limitations: 'One file.',
                                  references: ['output/pricing.js'],
                                },
                              ],
                            }
                          : { path: 'output/pricing.js' },
                      },
                    ],
              stop_reason: 'tool_use',
              stop_sequence: null,
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_creation_input_tokens: 2,
                cache_read_input_tokens: 3,
              },
            },
            { headers: report ? { 'x-report': '1' } : {} },
          );
        },
      });
      const read = fs.readFileSync;
      const now = performance.now.bind(performance);
      let offset = 0;
      const clock =
        mode === 'parent-deadline'
          ? spyOn(performance, 'now').mockImplementation(() => now() + offset)
          : null;
      const markerRead =
        mode === 'parent-deadline'
          ? spyOn(fs, 'readFileSync').mockImplementation(((
              ...args: Parameters<typeof fs.readFileSync>
            ) => {
              const result = read(...args);
              if (String(args[0]).endsWith('assessment-completion.json'))
                offset = 600001;
              return result;
            }) as typeof fs.readFileSync)
          : null;
      let passed = false;
      try {
        evidence.phase('whole-run-start');
        const verdict = await runPreparedConversation({
          runDir,
          scenarioDir,
          storyPath: join(scenarioDir, 'story.md'),
          launcherPath: gauntlet,
          workdir,
          launchCwd: workdir,
          runHomeDir: join(runDir, 'home'),
          configDir: join(runDir, 'home'),
          codingAgent: 'claude',
          normalizer: 'claude',
          logDir: logs,
          logGlob: '*.jsonl',
          snapshot: snapshotDir(logs, '*.jsonl'),
          checksSh: join(scenarioDir, 'checks.sh'),
          checksRepoRoot: resolve(import.meta.dir, '..'),
          preRecords: [],
          expectedChecks: null,
          gauntletBin: gauntlet,
          graderModel: 'claude-sonnet-4-6',
          assessmentBudget: { totalMs: 600000, reportGraceMs: 60000 },
          maxTime: '5s',
          envBase: {
            HOME: runDir,
            PATH: getEnv('PATH'),
            ANTHROPIC_API_KEY: 'offline-only',
            ANTHROPIC_BASE_URL: String(server.url),
          },
          shouldStop: () =>
            (['cancel', 'forced-kill'].includes(mode) && requests > 0) ||
            (mode === 'parent-cancel' && existsSync(join(runDir, 'cancel'))),
          identity: {
            scenario: 'demo',
            agent: 'claude',
            credential: 'offline',
            os: 'linux',
          },
        });
        evidence.phase('whole-run-return');
        if (
          [
            'reserve',
            'timeout',
            'retry',
            'checker-missing',
            'checker-crash',
            'check-fail',
            'trace-unavailable',
            'source-mismatch',
          ].includes(mode)
        )
          verifyPublishedFailure(runDir, verdict, mode);
        const role = JSON.parse(
          read(join(runDir, 'gauntlet-roles.json'), 'utf8'),
        ).assessment;
        expect(role.started_at).not.toBeNull();
        expect(role.finished_at).not.toBeNull();
        expect(role.process_exit).not.toBeNull();
        const out = join(runDir, role.out_dir);
        const marker = existsSync(join(out, 'assessment-completion.json'))
          ? JSON.parse(read(join(out, 'assessment-completion.json'), 'utf8'))
          : null;
        const economics = verdict.economics as unknown as RunEconomics;
        if (
          [
            'reserve',
            'retry',
            'trace-unavailable',
            'source-mismatch',
            'check-fail',
          ].includes(mode)
        ) {
          expect(verdict.error).toBeNull();
          expect(verdict.final).toBe(mode === 'check-fail' ? 'fail' : 'pass');
          expect(marker.status).toBe('completed');
          if (mode === 'reserve')
            expect(
              Date.parse(marker.terminal_at) - Date.parse(role.started_at),
            ).toBe(594999);
        } else {
          expect(verdict.final).toBe('indeterminate');
          expect(verdict.error).not.toBeNull();
        }
        if (['timeout', 'cancel', 'forced-kill'].includes(mode)) {
          expect(requests).toBe(mode === 'timeout' ? 2 : 1);
          expect(role.stop_cause).toBe(
            mode === 'timeout' ? 'timed_out' : 'cancelled',
          );
          expect(economics.gauntlet?.roles?.assessment.usage).toBeNull();
          expect(verdict.economics?.['assessment_accounting']).toMatchObject({
            logicalResponses: 0,
            physicalAttempts: mode === 'timeout' ? 2 : 1,
            unknownUsageAttemptIds:
              mode === 'timeout' ? ['001', '002'] : ['001'],
            complete: false,
          });
          if (mode === 'forced-kill') {
            expect(role.process_exit.signal).toBe('SIGKILL');
            expect(marker).toBeNull();
          } else {
            expect(marker.status).toBe(
              mode === 'timeout' ? 'timed_out' : 'cancelled',
            );
            expect(role.process_exit.code).toBe(1);
          }
        } else {
          expect(
            economics.gauntlet?.roles?.assessment.usage?.total_tokens,
          ).toBe(
            mode === 'conversion-error'
              ? 20
              : [
                    'reserve',
                    'late',
                    'parent-cancel',
                    'parent-deadline',
                    'writer-failure',
                    'double-fault',
                  ].includes(mode)
                ? 60
                : 40,
          );
          expect(
            economics.gauntlet?.roles?.assessment.usage?.est_cost_usd,
          ).toBeGreaterThan(0);
        }
        if (mode === 'double-fault') {
          expect(marker.status).toBe('completed');
          expect(role.process_exit.code).toBe(2);
        }
        if (mode === 'writer-failure' || mode === 'conversion-error') {
          expect(marker.status).toBe('errored');
          expect(role.process_exit.code).toBe(2);
        }
        if (mode === 'late') {
          expect(marker.status).toBe('timed_out');
          expect(role.stop_cause).toBe('timed_out');
        }
        if (mode === 'parent-cancel' || mode === 'parent-deadline') {
          expect(marker.status).toBe('completed');
          expect(role.stop_cause).toBe(
            mode === 'parent-cancel' ? 'cancelled' : 'timed_out',
          );
        }
        if (mode === 'retry') {
          expect(verdict.gauntlet?.status).toBe('pass');
          expect(role.process_exit.code).toBe(0);
          expect(economics.partial).toBe(true);
          expect(economics.total_est_cost_usd).toBeNull();
          expect(verdict.economics?.['assessment_accounting']).toMatchObject({
            logicalResponses: 2,
            physicalAttempts: 3,
            unknownUsageAttemptIds: ['001'],
            complete: false,
            error: null,
          });
        }
        evidence.phase('assertions-completed');
        passed = true;
      } finally {
        evidence.phase('cleanup-start');
        let cleanupCompleted = false;
        try {
          // Keep hung responses pending through every lifecycle assertion.
          await deferred.stop(server);
          cleanupCompleted = true;
        } finally {
          markerRead?.mockRestore();
          clock?.mockRestore();
          evidence.finish(passed, cleanupCompleted);
        }
      }
    },
    15_000,
  );
