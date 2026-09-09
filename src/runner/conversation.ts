import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { SuperpowersSpec } from '../agents/superpowers.ts';
import {
  captureTokenUsage,
  captureToolCalls,
  type snapshotDir,
} from '../capture/index.ts';
import { snapshotConversationOutput } from '../capture/output.ts';
import { compareRecords } from '../check/manifest.ts';
import { runPhase } from '../checks/index.ts';
import { compose } from '../composer.ts';
import type { CheckManifest } from '../contracts/check-manifest.ts';
import {
  type ConversationRecord,
  ConversationRecordSchema,
  EvidenceIndexSchema,
  type GauntletRoles,
  GauntletRolesSchema,
} from '../contracts/conversation.ts';
import {
  type CheckRecord,
  type FinalVerdict,
  type GauntletLayer,
  GauntletLayerSchema,
  type RunErrorStage,
} from '../contracts/verdict.ts';
import { buildRunEconomics } from '../economics.ts';
import { projectConversationStory } from './conversation-input.ts';
import { invokeGauntletRole } from './gauntlet-role.ts';
import { type RunIdentity, writePhase } from './phase.ts';

export type PreparedConversation = {
  runDir: string;
  scenarioDir: string;
  storyPath: string;
  launcherPath: string;
  workdir: string;
  launchCwd: string;
  runHomeDir: string;
  configDir: string;
  codingAgent: string;
  normalizer: 'claude' | 'codex' | 'pi';
  logDir: string;
  logGlob: string;
  snapshot: ReturnType<typeof snapshotDir>;
  checksSh: string;
  checksRepoRoot: string;
  preRecords: CheckRecord[];
  expectedChecks: CheckManifest | null;
  checkScratchRoot?: string;
  superpowers?: SuperpowersSpec;
  gauntletBin: string;
  graderModel: string;
  maxTime: string;
  envBase: Readonly<Record<string, string | undefined>>;
  shouldStop: () => boolean;
  identity: RunIdentity;
};

export function readConversationRecord(
  runDir: string,
): ConversationRecord | null {
  try {
    return ConversationRecordSchema.parse(
      JSON.parse(readFileSync(join(runDir, 'conversation.json'), 'utf8')),
    );
  } catch {
    return null;
  }
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
// Gauntlet's persisted record is authoritative. Only missing or invalid records
// need a Quorum fallback; a failed replacement must leave prior bytes intact.
function retainConversationRecord(
  runDir: string,
  fallback: ConversationRecord,
): ConversationRecord {
  const persisted = readConversationRecord(runDir);
  if (persisted !== null) return persisted;
  const path = join(runDir, 'conversation.json');
  const temporary = join(runDir, `conversation-${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(fallback, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return fallback;
}

function durationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (!match) throw new Error(`invalid role duration: ${value}`);
  return (
    Number(match[1]) *
    ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] ?? 's'] ?? 1000)
  );
}
function runId(scenario: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(scenario))
    throw new Error('invalid conversation scenario id');
  return `${scenario}_${new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(
      /\.\d{3}Z$/,
      'Z',
    )}_${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
}
function regularFile(root: string, path: string): string {
  EvidenceIndexSchema.parse({ files: [path] });
  const full = join(root, path);
  const real = realpathSync(full);
  const rel = relative(realpathSync(root), real);
  if (
    rel.startsWith('..') ||
    resolve(real) === resolve(root) ||
    !lstatSync(full).isFile()
  )
    throw new Error(`invalid evidence file: ${path}`);
  accessSync(full, constants.R_OK);
  return full;
}

async function runConversation(a: PreparedConversation): Promise<FinalVerdict> {
  const evidenceRoot = join(a.runDir, 'evidence');
  const role = (out_dir: string) => ({
    out_dir,
    model: a.graderModel,
    started_at: null,
    finished_at: null,
    process_exit: null,
    stop_cause: null,
  });
  const roles: GauntletRoles = {
    conversation: role(`conversation-agent/${runId(a.identity.scenario)}`),
    assessment: role(`gauntlet-agent/results/${runId(a.identity.scenario)}`),
  };
  writeJson(join(a.runDir, 'gauntlet-roles.json'), roles);
  let conversation: ConversationRecord | null = null;
  let gauntlet: GauntletLayer | null = null;
  let checks = [...a.preRecords];
  let stage: RunErrorStage = 'setup';
  let captureEmpty = true;
  const files: string[] = [];
  const index = () => {
    for (const file of files) regularFile(evidenceRoot, file);
    writeJson(
      join(evidenceRoot, 'index.json'),
      EvidenceIndexSchema.parse({ files: [...files].sort() }),
    );
  };
  const incomplete = (
    status: 'stopped' | 'timed_out' | 'errored',
    reason: string,
  ): ConversationRecord => ({
    status,
    endpoint: null,
    reason,
    timestamp: new Date().toISOString(),
    evidence: null,
  });
  const fail = (
    failureStage: RunErrorStage,
    message: string,
  ): FinalVerdict => ({
    ...compose({
      gauntlet,
      checks,
      captureEmpty,
      error: { stage: failureStage, message },
      expected: a.expectedChecks,
    }),
    ...(conversation ? { conversation } : {}),
  });
  const stopped = () => {
    conversation ??= incomplete('stopped', 'run cancelled');
    conversation = retainConversationRecord(a.runDir, conversation);
    return fail('stopped', 'run cancelled');
  };
  const stopRequested = async () => {
    if (a.shouldStop()) return true;
    await new Promise<void>((resolve) => setImmediate(resolve));
    return a.shouldStop();
  };
  let socketRoot: string | undefined;
  try {
    const projected = projectConversationStory(
      readFileSync(a.storyPath, 'utf8'),
    );
    const input = join(a.runDir, 'conversation-input');
    mkdirSync(input, { recursive: true });
    const brief = join(input, 'user-brief.md');
    const rubric = join(input, 'rubric.md');
    writeFileSync(brief, projected.brief, { mode: 0o600 });
    writeFileSync(rubric, projected.rubric, { mode: 0o600 });
    accessSync(join(a.scenarioDir, 'oracle.cjs'), constants.R_OK);
    for (const r of Object.values(roles))
      mkdirSync(join(a.runDir, r.out_dir), { recursive: true });
    if (await stopRequested()) return stopped();
    socketRoot = mkdtempSync(join(tmpdir(), 'qc-'));
    const socketPath = join(socketRoot, 's');
    const conversationOut = join(a.runDir, roles.conversation.out_dir);
    stage = 'gauntlet';
    writePhase(a.runDir, 'agent', a.identity);
    let conversationError: string | null = null;
    try {
      roles.conversation = await invokeGauntletRole({
        role: 'conversation',
        binary: a.gauntletBin,
        argv: [
          'converse',
          brief,
          '--launcher',
          a.launcherPath,
          '--workspace',
          a.launchCwd,
          '--out',
          conversationOut,
          '--completion',
          join(a.runDir, 'conversation.json'),
          '--tmux-socket',
          socketPath,
          '--model',
          `agent=${a.graderModel}`,
          ...(a.normalizer === 'claude' ? ['--startup', 'claude'] : []),
          '--max-time',
          a.maxTime,
        ],
        runDir: a.runDir,
        env: {
          ...a.envBase,
          QUORUM_AGENT_CWD: a.launchCwd,
          QUORUM_AGENT_HOME: a.runHomeDir,
        },
        deadlineMs: durationMs(a.maxTime),
        shouldStop: a.shouldStop,
        socketPath,
      });
    } catch (error) {
      conversationError =
        error instanceof Error ? error.message : String(error);
      roles.conversation = GauntletRolesSchema.parse(
        JSON.parse(readFileSync(join(a.runDir, 'gauntlet-roles.json'), 'utf8')),
      ).conversation;
    }
    conversation =
      readConversationRecord(a.runDir) ??
      incomplete(
        roles.conversation.stop_cause === 'cancelled'
          ? 'stopped'
          : roles.conversation.stop_cause === 'timed_out'
            ? 'timed_out'
            : 'errored',
        'conversation ended without a valid endpoint',
      );
    conversation = retainConversationRecord(a.runDir, conversation);
    stage = 'capture';
    const capture = captureToolCalls({
      logDir: a.logDir,
      logGlob: a.logGlob,
      snapshot: a.snapshot,
      normalizer: a.normalizer,
      runDir: a.runDir,
      launchCwd: a.launchCwd,
    });
    const retain = (source: string, target: string) => {
      const dest = join(evidenceRoot, target);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(source, dest);
      files.push(target);
    };
    for (const source of capture.sourceLogs)
      retain(
        regularFile(a.logDir, relative(a.logDir, source)),
        `native/${relative(a.logDir, source)}`,
      );
    for (const path of ['exchange.jsonl', 'captures']) {
      const source = join(conversationOut, path);
      if (!existsSync(source)) continue;
      if (path === 'captures')
        files.push(
          ...snapshotConversationOutput(
            source,
            join(evidenceRoot, 'visible/captures'),
          ).map((p) => `visible/captures/${p}`),
        );
      else retain(regularFile(conversationOut, path), `visible/${path}`);
    }
    if (conversation.evidence !== null) {
      const source = regularFile(a.runDir, conversation.evidence.path);
      const visible = relative(conversationOut, source);
      if (!visible.startsWith('captures/') || !visible.endsWith('.ansi'))
        throw new Error('completion must reference a visible ANSI capture');
      const captureJson = regularFile(
        conversationOut,
        visible.replace(/\.ansi$/, '.json'),
      );
      const grid = z
        .object({ cells: z.array(z.array(z.object({ ch: z.string() }))) })
        .parse(JSON.parse(readFileSync(captureJson, 'utf8')));
      const rendered = grid.cells
        .map((row) =>
          row
            .map((cell) => cell.ch)
            .join('')
            .trimEnd(),
        )
        .join('\n')
        .trimEnd();
      if (!rendered.includes(conversation.evidence.quote))
        throw new Error('completion evidence is not a retained visible quote');
      writeJson(join(evidenceRoot, 'conversation.json'), {
        ...conversation,
        evidence: { ...conversation.evidence, path: `visible/${visible}` },
      });
    } else writeJson(join(evidenceRoot, 'conversation.json'), conversation);
    files.push('conversation.json');
    if (existsSync(capture.path)) retain(capture.path, 'trajectory.json');
    files.push(
      ...snapshotConversationOutput(
        a.workdir,
        join(evidenceRoot, 'output'),
      ).map((p) => `output/${p}`),
    );
    writeJson(join(evidenceRoot, 'checks.json'), checks);
    files.push('checks.json');
    index();
    captureEmpty = capture.availability !== 'available';
    if (
      roles.conversation.stop_cause === 'cancelled' ||
      (await stopRequested())
    )
      return stopped();
    if (conversationError !== null) return fail('gauntlet', conversationError);
    if (conversation.status !== 'completed')
      return fail('gauntlet', conversation.reason);
    if (
      roles.conversation.stop_cause !== null ||
      roles.conversation.process_exit?.code !== 0
    )
      return fail(
        'gauntlet',
        'conversation completed but subject cleanup was not confirmed',
      );
    if (capture.errors.length > 0 || captureEmpty)
      return fail(
        'capture',
        `native conversation capture unavailable: ${capture.errors.map((e) => e.message).join('; ')}`,
      );
    await captureTokenUsage({
      logDir: a.logDir,
      logGlob: a.logGlob,
      snapshot: a.snapshot,
      normalizer: a.normalizer,
      runDir: a.runDir,
      launchCwd: a.launchCwd,
    });
    if (await stopRequested()) return stopped();
    stage = 'checks';
    writePhase(a.runDir, 'checks', a.identity);
    const post = await runPhase({
      checksSh: a.checksSh,
      phase: 'post',
      workdir: join(evidenceRoot, 'output'),
      repoRoot: a.checksRepoRoot,
      transcriptPath: capture.path,
      captureAvailability: capture.availability,
      runDir: a.runDir,
      scenarioDir: a.scenarioDir,
      configDir: a.configDir,
      codingAgent: a.codingAgent,
      superpowers: a.superpowers,
      scratchRoot: a.checkScratchRoot,
    });
    checks = [...checks, ...post.records];
    writeJson(join(evidenceRoot, 'checks.json'), checks);
    index();
    if (await stopRequested()) return stopped();
    if (post.exitCode !== 0)
      return fail(
        'checks',
        `post-checks crashed (exit ${post.exitCode}): ${post.stderr}`,
      );
    if (a.expectedChecks !== null) {
      const mismatch = compareRecords(a.expectedChecks, checks);
      if (mismatch.missing.length || mismatch.unexpected.length) {
        return fail(
          'checks',
          `expected-check manifest mismatch: ${JSON.stringify(mismatch)}`,
        );
      }
    }
    stage = 'gauntlet';
    writePhase(a.runDir, 'agent', a.identity);
    const out = join(a.runDir, roles.assessment.out_dir);
    roles.assessment = await invokeGauntletRole({
      role: 'assessment',
      binary: a.gauntletBin,
      argv: [
        'assess',
        rubric,
        '--evidence-root',
        evidenceRoot,
        '--evidence-index',
        join(evidenceRoot, 'index.json'),
        '--out',
        out,
        '--model',
        `agent=${a.graderModel}`,
        '--max-time',
        '2m',
      ],
      runDir: a.runDir,
      env: a.envBase,
      deadlineMs: 120000,
      shouldStop: a.shouldStop,
    });
    const processExit = roles.assessment.process_exit;
    try {
      gauntlet = GauntletLayerSchema.parse({
        ...JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')),
        run_id: basename(out),
        ...(processExit ? { process_exit: processExit } : {}),
      });
    } catch {
      gauntlet = {
        status: 'investigate',
        summary: `Assessment inconclusive: child exit ${JSON.stringify(processExit)}`,
        reasoning: 'No valid allocated assessment result',
        run_id: basename(out),
        ...(processExit ? { process_exit: processExit } : {}),
      };
    }
    if (roles.assessment.stop_cause === 'cancelled' || (await stopRequested()))
      return stopped();
    const expectedExit = gauntlet.status === 'pass' ? 0 : 1;
    if (
      processExit?.code !== expectedExit ||
      roles.assessment.stop_cause !== null
    )
      return fail(
        'gauntlet',
        'Assessment inconclusive: assessor process failed',
      );
    const criteria = gauntlet.criteria;
    if (
      !criteria?.length ||
      criteria.some(
        (c) =>
          !c.criterion.trim() ||
          !c.evidence.trim() ||
          !['pass', 'fail', 'unclear'].includes(c.verdict),
      ) ||
      (gauntlet.status === 'pass' && criteria.some((c) => c.verdict !== 'pass'))
    )
      return fail(
        'gauntlet',
        'Assessment inconclusive: missing or inconsistent criteria',
      );
    const verdict = compose({
      conversation,
      gauntlet,
      checks,
      captureEmpty,
      error: null,
      expected: a.expectedChecks,
    });
    return { ...verdict, conversation };
  } catch (error) {
    conversation =
      readConversationRecord(a.runDir) ??
      conversation ??
      incomplete('errored', String(error));
    conversation = retainConversationRecord(a.runDir, conversation);
    return fail(stage, error instanceof Error ? error.message : String(error));
  } finally {
    if (socketRoot !== undefined)
      rmSync(socketRoot, { recursive: true, force: true });
  }
}

/** Price every role outcome, including failures before an assessment starts. */
export async function runPreparedConversation(
  a: PreparedConversation,
): Promise<FinalVerdict> {
  const verdict = await runConversation(a);
  let economics: FinalVerdict['economics'] = null;
  try {
    const measured = await buildRunEconomics(a.runDir);
    economics =
      measured === null ? null : z.record(z.unknown()).parse(measured);
  } catch {
    /* Cost failure cannot erase the verdict. */
  }
  return { ...verdict, economics };
}
