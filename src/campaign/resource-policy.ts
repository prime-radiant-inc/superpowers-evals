import type { Block } from '../contracts/campaign/campaign.ts';
import type { PoolPolicy } from '../contracts/campaign/experiment.ts';
import { poolKey } from '../contracts/campaign/pool.ts';
import type { Credential } from '../contracts/credential.ts';
import { GLOBAL_POOL } from './simulate.ts';

export class ResourcePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourcePolicyError';
  }
}

/**
 * Compile the immutable campaign admission policy for every active credential
 * pool. All registry aliases of an active pool participate, including aliases
 * not selected directly by an arm or grader.
 */
export function compileResourcePolicy(
  registry: Readonly<Record<string, Credential>>,
  activeCredentialNames: readonly string[],
): ReadonlyMap<string, PoolPolicy> {
  const activePools = new Set<string>();
  for (const name of activeCredentialNames) {
    const credential = registry[name];
    if (credential === undefined) {
      throw new ResourcePolicyError(
        `active credential ${name} is absent from the public registry`,
      );
    }
    const poolId = poolKey(credential, name);
    if (poolId === GLOBAL_POOL) {
      throw new ResourcePolicyError(
        `credential ${name} uses the reserved global pool ${GLOBAL_POOL}`,
      );
    }
    activePools.add(poolId);
  }

  const result = new Map<string, PoolPolicy>();
  for (const poolId of [...activePools].sort()) {
    const aliases = Object.entries(registry).filter(
      ([name, credential]) => poolKey(credential, name) === poolId,
    );
    const limits = aliases.flatMap(([, credential]) =>
      credential.max_concurrency === undefined
        ? []
        : [credential.max_concurrency],
    );
    if (limits.length === 0) {
      throw new ResourcePolicyError(
        `pool ${poolId} needs an explicit concurrency limit`,
      );
    }
    result.set(poolId, {
      pool_id: poolId,
      max_concurrency: Math.min(...limits),
      launch_spacing_seconds: Math.max(
        0,
        ...aliases.flatMap(([, credential]) =>
          credential.launch_spacing_seconds === undefined
            ? []
            : [credential.launch_spacing_seconds],
        ),
      ),
    });
  }
  return result;
}

/** Per sample: one subject slot, one actual grader slot, and one global slot. */
export function blockDemandVector(args: {
  block: Pick<Block, 'sample_ids'>;
  sampleArmCredentialPool: (sampleId: string) => string;
  graderPool: string;
}): Map<string, number> {
  const demand = new Map<string, number>();
  for (const sampleId of args.block.sample_ids) {
    const subject = args.sampleArmCredentialPool(sampleId);
    demand.set(subject, (demand.get(subject) ?? 0) + 1);
    demand.set(args.graderPool, (demand.get(args.graderPool) ?? 0) + 1);
    demand.set(GLOBAL_POOL, (demand.get(GLOBAL_POOL) ?? 0) + 1);
  }
  return demand;
}

/** Reject a block that can never fit the frozen pool or global capacities. */
export function assertFeasible(
  demand: ReadonlyMap<string, number>,
  policy: ReadonlyMap<string, PoolPolicy>,
  globalCapacity: number,
): void {
  if (!Number.isInteger(globalCapacity) || globalCapacity < 1) {
    throw new ResourcePolicyError(
      `global capacity must be a positive integer, got ${globalCapacity}`,
    );
  }
  for (const [poolId, needed] of demand) {
    if (!Number.isInteger(needed) || needed < 1) {
      throw new ResourcePolicyError(
        `pool ${poolId} has invalid demand ${needed}`,
      );
    }
    if (poolId === GLOBAL_POOL) {
      if (needed > globalCapacity) {
        throw new ResourcePolicyError(
          `global demand ${needed} exceeds capacity ${globalCapacity}`,
        );
      }
      continue;
    }
    const pool = policy.get(poolId);
    if (pool === undefined) {
      throw new ResourcePolicyError(
        `demand references unregistered pool ${poolId}`,
      );
    }
    if (needed > pool.max_concurrency) {
      throw new ResourcePolicyError(
        `pool ${poolId} demand ${needed} exceeds capacity ${pool.max_concurrency}`,
      );
    }
  }
}
