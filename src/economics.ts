import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';
import { z } from 'zod';
import {
  type PerModelUsageSchema,
  type TokenUsage,
  TokenUsageSchema,
} from './contracts/economics.ts';
import { estimateUsageSidecar } from './obol/index.ts';

/** Token totals exposed in each economics block (mirrors Python's shell). */
interface TokenShell {
  readonly input: number;
  readonly output: number;
  readonly cache_create: number;
  readonly cache_read: number;
  readonly total: number;
}

/** obol provenance carried alongside a priced block (null when unpriced). */
interface ObolProvenance {
  readonly per_model: Readonly<
    Record<string, z.infer<typeof PerModelUsageSchema>>
  >;
  readonly unpriced_models: readonly string[];
  readonly approximations: readonly { kind: string; detail: string | null }[];
  readonly pricing_as_of: string;
}

interface PerModelEntry {
  readonly model: string;
  readonly tokens: TokenShell;
  readonly est_cost_usd: number | null;
}

interface GauntletBlock {
  readonly duration_ms: number | null;
  readonly model: string | null;
  readonly tokens: TokenShell;
  readonly est_cost_usd: number | null;
  readonly has_unpriced_model: boolean;
  readonly obol: ObolProvenance | null;
}

interface CodingAgentBlock {
  readonly duration_ms: number | null;
  readonly model: string | null;
  readonly models: readonly PerModelEntry[];
  readonly tokens: TokenShell;
  readonly est_cost_usd: number | null;
  readonly tool_result_total_bytes: number;
  readonly has_unpriced_model: boolean;
  readonly obol: ObolProvenance | null;
}

export interface RunEconomics {
  readonly pricing_asof: string | null;
  readonly gauntlet: GauntletBlock | null;
  readonly coding_agent: CodingAgentBlock | null;
  readonly total_est_cost_usd: number | null;
  readonly partial: boolean;
}

const ZERO_TOKENS: TokenShell = {
  input: 0,
  output: 0,
  cache_create: 0,
  cache_read: 0,
  total: 0,
};

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Tolerant zod view over gauntlet result.json: every field optional so a
 *  partial/loose result still parses (parity with Python economics._read_json,
 *  which never throws on a malformed result). */
const GauntletResultLooseSchema = z
  .object({
    duration_ms: z.number(),
    config: z.object({ model: z.string() }).partial().passthrough(),
  })
  .partial()
  .passthrough();

/** Read + tolerantly parse a JSON file; null on missing/malformed/non-object. */
function readResultLoose(
  path: string,
): z.infer<typeof GauntletResultLooseSchema> | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = GauntletResultLooseSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function tokensShell(u: TokenUsage): TokenShell {
  return {
    input: u.total_input,
    output: u.total_output,
    cache_create: u.total_cache_create,
    cache_read: u.total_cache_read,
    total: u.total_tokens,
  };
}

function obolProvenance(u: TokenUsage): ObolProvenance | null {
  if (u.pricing_as_of === null) {
    return null;
  }
  return {
    per_model: u.models,
    unpriced_models: u.unpriced_models,
    approximations: u.approximations,
    pricing_as_of: u.pricing_as_of,
  };
}

/** First sorted results dir carrying a result.json. Python's
 *  economics._gauntlet_results_dir uses `next(sorted(...))` — first, not
 *  newest; Spec 1 has exactly one per run. */
function gauntletResultPath(runDir: string): string | null {
  const base = join(runDir, 'gauntlet-agent', 'results');
  if (!existsSync(base)) {
    return null;
  }
  const hits = [
    ...new Glob('*/result.json').scanSync({ cwd: base, absolute: true }),
  ].sort();
  return hits[0] ?? null;
}

function buildGauntletBlock(
  result: z.infer<typeof GauntletResultLooseSchema> | null,
  usage: TokenUsage | null,
): GauntletBlock {
  const dur = result?.duration_ms;
  const configModel = result?.config?.model ?? null;
  return {
    duration_ms: dur === undefined ? null : Math.trunc(dur),
    model: usage?.model ?? configModel,
    tokens: usage ? tokensShell(usage) : ZERO_TOKENS,
    est_cost_usd: usage?.est_cost_usd ?? null,
    has_unpriced_model: (usage?.unpriced_models.length ?? 0) > 0,
    obol: usage ? obolProvenance(usage) : null,
  };
}

function buildCodingAgentBlock(usage: TokenUsage): CodingAgentBlock {
  const models: PerModelEntry[] = Object.entries(usage.models)
    .map(([model, m]) => ({
      model,
      tokens: {
        input: m.total_input,
        output: m.total_output,
        cache_create: m.total_cache_create,
        cache_read: m.total_cache_read,
        total: m.total_tokens,
      },
      est_cost_usd: m.est_cost_usd,
    }))
    .sort((a, b) => (b.est_cost_usd ?? -1) - (a.est_cost_usd ?? -1));
  const hasUnpriced =
    usage.unpriced_models.length > 0 ||
    models.some((m) => m.est_cost_usd === null);
  return {
    duration_ms: usage.duration_ms ?? null,
    model: usage.model,
    models,
    tokens: tokensShell(usage),
    est_cost_usd: usage.est_cost_usd,
    tool_result_total_bytes: usage.tool_result_total_bytes ?? 0,
    has_unpriced_model: hasUnpriced,
    obol: obolProvenance(usage),
  };
}

/** Compose the run-level economics block from the frozen coding-agent usage
 *  file and the gauntlet sidecar. Returns null only when neither source exists.
 *  The gauntlet block is built whenever result.json OR its usage exists. */
export async function buildRunEconomics(
  runDir: string,
): Promise<RunEconomics | null> {
  // Gauntlet block — built whenever result.json OR usage exists.
  let gauntlet: GauntletBlock | null = null;
  const resultPath = gauntletResultPath(runDir);
  const gResult = resultPath ? readResultLoose(resultPath) : null;
  const gUsage = resultPath
    ? await estimateUsageSidecar(join(resultPath, '..', 'usage.jsonl'))
    : null;
  if (gResult !== null || gUsage !== null) {
    gauntlet = buildGauntletBlock(gResult, gUsage);
  }

  // Coding-agent block — frozen, already priced at capture time.
  let coding: CodingAgentBlock | null = null;
  const codingPath = join(runDir, 'coding-agent-token-usage.json');
  if (existsSync(codingPath)) {
    const usage = TokenUsageSchema.parse(
      JSON.parse(readFileSync(codingPath, 'utf8')),
    );
    coding = buildCodingAgentBlock(usage);
  }

  if (gauntlet === null && coding === null) {
    return null;
  }

  const gCost = gauntlet?.est_cost_usd ?? null;
  const cCost = coding?.est_cost_usd ?? null;
  const anyUnpriced =
    (coding?.has_unpriced_model ?? false) ||
    (gauntlet?.has_unpriced_model ?? false);
  const total =
    gCost !== null && cCost !== null && !anyUnpriced
      ? round6(gCost + cCost)
      : null;
  const partial =
    gauntlet === null ||
    coding === null ||
    gCost === null ||
    cCost === null ||
    anyUnpriced;
  // Python iterates (coding, gauntlet) — coding first.
  const pricingAsof =
    coding?.obol?.pricing_as_of ?? gauntlet?.obol?.pricing_as_of ?? null;

  return {
    pricing_asof: pricingAsof,
    gauntlet,
    coding_agent: coding,
    total_est_cost_usd: total,
    partial,
  };
}
