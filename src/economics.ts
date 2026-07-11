import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Glob } from 'bun';
import type { z } from 'zod';
import {
  type OpenRouterEconomics,
  OpenRouterEconomicsSchema,
  type PerModelUsageSchema,
  type TokenUsage,
} from './contracts/economics.ts';
import { estimateUsageSidecar } from './obol/index.ts';
import {
  type OpenRouterAttestation,
  OpenRouterAttestationSchema,
} from './openrouter/generations.ts';

/** Token totals exposed in each economics block. */
interface TokenShell {
  readonly input: number;
  readonly output: number;
  readonly cache_create: number;
  readonly cache_read: number;
  readonly total: number;
}

/** obol provenance carried alongside a priced block. Present whenever the
 *  source usage object carries a `pricing_as_of` key — even when its value is
 *  null (an all-unpriced sidecar). Absent (null) only for pre-obol legacy
 *  frozen files that never had the key. */
interface ObolProvenance {
  readonly per_model: Readonly<
    Record<string, z.infer<typeof PerModelUsageSchema>>
  >;
  readonly unpriced_models: readonly string[];
  readonly approximations: readonly { kind: string; detail: string | null }[];
  readonly pricing_as_of: string | null;
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
  readonly openrouter?: OpenRouterEconomics | undefined;
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

/** A plain JSON object. All economics reads are schema-less: every field is
 *  fetched via tolerant accessors with defaults so a malformed or legacy
 *  artifact degrades per-field rather than crashing. */
type JsonObject = Record<string, unknown>;

/** Read + parse a JSON file; null on missing/malformed/non-object. */
function readJsonObject(path: string): JsonObject | null {
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
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as JsonObject)
    : null;
}

function numField(o: JsonObject, key: string): number {
  const v = o[key];
  return typeof v === 'number' ? v : 0;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function tokensShell(o: JsonObject): TokenShell {
  return {
    input: numField(o, 'total_input'),
    output: numField(o, 'total_output'),
    cache_create: numField(o, 'total_cache_create'),
    cache_read: numField(o, 'total_cache_read'),
    total: numField(o, 'total_tokens'),
  };
}

function asJsonObject(v: unknown): JsonObject | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as JsonObject)
    : null;
}

/** Cost field: a number stays, anything else (missing/null/wrong-type) -> null. */
function costField(o: JsonObject, key: string): number | null {
  const v = o[key];
  return typeof v === 'number' ? v : null;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : [];
}

function approximationsList(
  v: unknown,
): { kind: string; detail: string | null }[] {
  if (!Array.isArray(v)) return [];
  const out: { kind: string; detail: string | null }[] = [];
  for (const item of v) {
    const o = asJsonObject(item);
    if (o === null) continue;
    out.push({
      kind: strOrNull(o['kind']) ?? '',
      detail: strOrNull(o['detail']),
    });
  }
  return out;
}

function perModelMap(
  v: unknown,
): Record<string, z.infer<typeof PerModelUsageSchema>> {
  const obj = asJsonObject(v);
  return obj === null
    ? {}
    : (obj as Record<string, z.infer<typeof PerModelUsageSchema>>);
}

/** The nested obol provenance block, or null for pre-obol legacy frozen files:
 *  null ONLY when the `pricing_as_of` key is ABSENT; a present-but-null value
 *  still yields a provenance block. */
function obolProvenance(u: JsonObject): ObolProvenance | null {
  if (!('pricing_as_of' in u)) {
    return null;
  }
  return {
    per_model: perModelMap(u['models']),
    unpriced_models: stringList(u['unpriced_models']),
    approximations: approximationsList(u['approximations']),
    pricing_as_of: strOrNull(u['pricing_as_of']),
  };
}

/** First sorted results dir carrying a result.json OR a usage.jsonl. A
 *  usage.jsonl-only dir must still be selected so its sidecar gets priced. */
function gauntletResultsDir(runDir: string): string | null {
  const base = join(runDir, 'gauntlet-agent', 'results');
  if (!existsSync(base)) {
    return null;
  }
  const hits = [
    ...new Glob('*/result.json').scanSync({ cwd: base, absolute: true }),
    ...new Glob('*/usage.jsonl').scanSync({ cwd: base, absolute: true }),
  ].map(dirname);
  return [...new Set(hits)].sort()[0] ?? null;
}

/** Token shell from a typed obol `TokenUsage` (gauntlet sidecar always carries
 *  every field, unlike the schema-less frozen file). */
function tokensShellFromUsage(u: TokenUsage): TokenShell {
  return {
    input: u.total_input,
    output: u.total_output,
    cache_create: u.total_cache_create,
    cache_read: u.total_cache_read,
    total: u.total_tokens,
  };
}

function buildGauntletBlock(
  result: JsonObject | null,
  usage: TokenUsage | null,
): GauntletBlock {
  const r = result ?? {};
  const dur = r['duration_ms'];
  const config = asJsonObject(r['config']);
  const configModel = config !== null ? strOrNull(config['model']) : null;
  return {
    duration_ms: typeof dur === 'number' ? Math.trunc(dur) : null,
    model: (usage?.model ?? null) || configModel,
    tokens: usage ? tokensShellFromUsage(usage) : ZERO_TOKENS,
    est_cost_usd: usage?.est_cost_usd ?? null,
    has_unpriced_model: (usage?.unpriced_models.length ?? 0) > 0,
    obol: usage
      ? {
          per_model: usage.models,
          unpriced_models: usage.unpriced_models,
          approximations: usage.approximations,
          pricing_as_of: usage.pricing_as_of,
        }
      : null,
  };
}

function buildOpenRouterEconomics(
  attestation: OpenRouterAttestation,
  estimatedCostUsd: number | null,
): OpenRouterEconomics {
  const chargedCostUsd = attestation.charged_cost_usd;
  return OpenRouterEconomicsSchema.parse({
    charged_cost_usd: chargedCostUsd,
    estimated_cost_usd: estimatedCostUsd,
    cost_delta_usd:
      chargedCostUsd !== null && estimatedCostUsd !== null
        ? round6(chargedCostUsd - estimatedCostUsd)
        : null,
    generation_count: attestation.generations.length,
    model: attestation.expected.model,
    provider: attestation.expected.provider,
  });
}

function openRouterAttestationEconomics(
  runDir: string,
): OpenRouterAttestation | null {
  const raw = readJsonObject(join(runDir, 'openrouter-generations.json'));
  if (raw === null) return null;
  const parsed = OpenRouterAttestationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function buildCodingAgentBlock(
  usage: JsonObject,
  attestation: OpenRouterAttestation | null,
): CodingAgentBlock {
  const rawModels = asJsonObject(usage['models']) ?? {};
  const models: PerModelEntry[] = Object.entries(rawModels)
    .map(([model, raw]) => {
      const m = asJsonObject(raw) ?? {};
      return {
        model,
        tokens: tokensShell(m),
        est_cost_usd: costField(m, 'est_cost_usd'),
      };
    })
    // Sort by cost descending; a null cost maps to 0 and ties (stably) with a
    // genuine $0-priced free-tier model.
    .sort((a, b) => (b.est_cost_usd ?? 0) - (a.est_cost_usd ?? 0));
  const hasUnpriced =
    stringList(usage['unpriced_models']).length > 0 ||
    models.some((m) => m.est_cost_usd === null);
  const estimatedCostUsd = costField(usage, 'est_cost_usd');
  const openrouter =
    attestation === null
      ? null
      : buildOpenRouterEconomics(attestation, estimatedCostUsd);
  return {
    duration_ms: costField(usage, 'duration_ms'),
    model: strOrNull(usage['model']),
    models,
    tokens: tokensShell(usage),
    est_cost_usd: estimatedCostUsd,
    tool_result_total_bytes: numField(usage, 'tool_result_total_bytes'),
    has_unpriced_model: hasUnpriced,
    obol: obolProvenance(usage),
    ...(openrouter === null ? {} : { openrouter }),
  };
}

/** Sidecar pricing seam: defaults to the real obol estimator. Injected in
 *  tests so the gauntlet path can be exercised without shelling out to obol. */
export type SidecarEstimator = (path: string) => Promise<TokenUsage | null>;

/** Compose the run-level economics block from the frozen coding-agent usage
 *  file and the gauntlet sidecar. Returns null only when neither source exists.
 *  The gauntlet block is built whenever result.json OR its usage exists.
 *
 *  Every read is best-effort: a malformed/legacy artifact degrades per-field to
 *  null + `partial:true` rather than throwing. The runner additionally guards
 *  the call site so even an unexpected throw never destroys a composed verdict. */
export async function buildRunEconomics(
  runDir: string,
  sidecarEstimator: SidecarEstimator = estimateUsageSidecar,
): Promise<RunEconomics | null> {
  // Gauntlet block — built whenever result.json OR usage exists.
  let gauntlet: GauntletBlock | null = null;
  const resultsDir = gauntletResultsDir(runDir);
  const gResult = resultsDir
    ? readJsonObject(join(resultsDir, 'result.json'))
    : null;
  const gUsage = resultsDir
    ? await sidecarEstimator(join(resultsDir, 'usage.jsonl'))
    : null;
  if (gResult !== null || gUsage !== null) {
    gauntlet = buildGauntletBlock(gResult, gUsage);
  }

  // Coding-agent block — frozen, already priced at capture time. Read
  // schema-less: a legacy pre-obol file lacking obol keys still builds a block
  // with obol=null instead of crashing.
  let coding: CodingAgentBlock | null = null;
  const codingUsage = readJsonObject(
    join(runDir, 'coding-agent-token-usage.json'),
  );
  if (codingUsage !== null) {
    coding = buildCodingAgentBlock(
      codingUsage,
      openRouterAttestationEconomics(runDir),
    );
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
    anyUnpriced ||
    coding?.openrouter?.charged_cost_usd === null;
  // Take the first truthy pricing_as_of across (coding, gauntlet), so a
  // present-but-null (falsy) value falls through.
  let pricingAsof: string | null = null;
  for (const block of [coding, gauntlet]) {
    const candidate = block?.obol?.pricing_as_of;
    if (candidate) {
      pricingAsof = candidate;
      break;
    }
  }

  return {
    pricing_asof: pricingAsof,
    gauntlet,
    coding_agent: coding,
    total_est_cost_usd: total,
    partial,
  };
}
