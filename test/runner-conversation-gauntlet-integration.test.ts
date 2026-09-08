// Cross-repository wire qualification: actual Gauntlet CLI processes and tmux,
// with a localhost-only Anthropic transport supplying finite scripted replies.
import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { snapshotDir } from '../src/capture/index.ts';
import { GauntletRolesSchema } from '../src/contracts/conversation.ts';
import type { RunEconomics } from '../src/economics.ts';
import { getEnv } from '../src/env.ts';
import { runPreparedConversation } from '../src/runner/conversation.ts';

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
                  status,
                  summary: 'Retained pricing inspected',
                  reasoning: 'Assessment read output/pricing.js',
                  criteria: [
                    {
                      criterion: 'Pricing returns 42.',
                      verdict: status === 'investigate' ? 'unclear' : status,
                      evidence: `output/pricing.js: ${assessedOutput}`,
                    },
                    ...(unclear
                      ? [
                          {
                            criterion: 'Delivery is verified.',
                            verdict: 'unclear',
                            evidence:
                              'output/pricing.js: verification evidence is incomplete',
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
process.stdout.write('Which currency?\\n');
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
        ]);
      } finally {
        await server.stop(true);
        rmSync(runDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
