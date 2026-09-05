# PR 2258 Final Source State Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Continue the already selected subagent/review workflow; no new execution-choice prompt is needed.

**Goal:** Implement the filesystem comparison that rejects candidate observer evidence when its bound source state changes before final acceptance.

**Architecture:** A single observer module captures an inventory from caller-supplied transcript and artifact roots and compares a later observation with that inventory. Candidate construction consumes the capture function; the eventual publisher integration consumes the verifier after its existing stopped-container gate. Both functions use the same inventory traversal and byte-reading logic.

**Tech Stack:** Existing TypeScript, Bun, Zod and Node filesystem/crypto APIs. Reuse `readPinnedNoFollowBytes` for scoped byte reads. No dependencies or process runtime.

**Spec:** [Approved comparison design](../specs/2026-09-05-pr2258-parallel-comparison-design.md#capture-finalization-and-replay), amended following Drew's simpler container-boundary decision. Source inspected at `1b913a93`.

## Global Constraints

- Use the existing campaign container boundary for this first comparison. Do not add a Gauntlet supervisor, process-ownership receipt protocol, delegated cgroup, or new runtime dependency.
- No live runs, Docker/Linux execution, installed changes, credentials, spending, push or merge are authorized by this source plan.
- A mismatch is unusable evidence. Do not repair candidate bytes, regenerate a score, rewrite a manifest or launch a replacement.
- Expected source roots come from the caller's trusted run binding, never from the candidate inventory. Roots are private source locations; published replay must not dereference them.
- Compare full raw logs, not only reviewed prefixes. Harmless late telemetry also makes an older candidate stale.
- Preserve existing strict scores, input guards, reviewed-prefix semantics and all historical V1 files. No format converter or compatibility implementation.
- This is the independently testable filesystem slice. It does not activate the unfinished V2 binding, candidate bundle, scorer or publisher path. Those consumers must use this verifier; passing this slice alone is not observer qualification.

## Delivery boundary

The runtime binding and candidate-bundle producer are still unfinished. Do not
add a permissive optional hook to the publisher or use the presence of a bundle
as an enablement signal. Production integration must obtain required-observer
policy and roots from the pinned execution/binding and refuse missing candidates.
That integration belongs with the complete V2 producer, preventing an active
publisher path that can silently skip its only caller's missing output.

The source deliverable here has two consumers of one implementation: candidate
inventory capture and final inventory verification. It reserves no generic bundle,
review, registry or publication schema. One task/review gate is sufficient.

### Task 1: Capture and verify the complete scoped source inventory

**Files:**

- Create: `src/experiments/observer/final-state.ts`
- Create: `test/observer-final-state.test.ts`
- Read/reuse: `src/appliance/credential-scope.ts:556` (`readPinnedNoFollowBytes`)
- Read: `src/campaign/attempt-publish.ts:339` (eventual integration boundary)

**Interfaces:**

```ts
export interface FinalStateRoot {
  id: string;
  kind: 'transcripts' | 'artifacts';
  path: string; // absolute; supplied by trusted run binding
}

export interface FinalStateNode {
  root_id: string;
  path: string; // normalized relative path; '' identifies the root directory
  kind: 'directory' | 'file';
  device: string;
  inode: string;
  bytes: number | null;
  sha256: string | null;
}

export interface FinalState {
  schema_version: 2;
  roots: { id: string; kind: FinalStateRoot['kind'] }[];
  nodes: FinalStateNode[];
}

export class FinalStateError extends Error {
  readonly code:
    | 'invalid_state'
    | 'source_unavailable'
    | 'source_changed'
    | 'final_state_mismatch';
  constructor(code: FinalStateError['code']);
}

export function captureFinalState(roots: readonly FinalStateRoot[]): FinalState;
export function verifyFinalState(
  roots: readonly FinalStateRoot[], candidate: FinalState,
): void;
```

Use strict Zod objects for the returned inventory and its validation. `bytes`
is a nonnegative safe integer on files, null on directories. File digests are
lowercase SHA-256; directory digests are null. Device/inode are decimal strings
from bigint filesystem stats, avoiding lossy numeric identity conversion.
Require nonempty unique root IDs, at least one root of each kind, unique node
keys and a root-directory node for every root. Candidate paths contain no empty
components, `.`/`..`, backslash, NUL, absolute or drive-qualified paths; only the
root directory itself uses the empty path. Reject unknown fields and wrong
kind/null combinations. The verifier validates before reading any source.

- [ ] **Step 1: Add actual filesystem regressions.** Build private temporary
  `logs` and `workdir` directories using `mkdtempSync`, canonicalize the fixture
  base with `realpathSync`, and remove only that test's directory in `finally`.
  Seed `logs/parent.jsonl` with `{"type":"fixture"}\n` and
  `workdir/design.md` with `Draft\n`. This fixture deliberately tests bytes and
  inventory, not a qualified transcript dialect. Define roots:

```ts
const roots: FinalStateRoot[] = [
  { id: 'logs', kind: 'transcripts', path: join(base, 'logs') },
  { id: 'workdir', kind: 'artifacts', path: join(base, 'workdir') },
];
const candidate = captureFinalState(roots);
expect(() => verifyFinalState(roots, candidate)).not.toThrow();
appendFileSync(join(base, 'logs', 'parent.jsonl'), '{"late":true}\n');
try {
  verifyFinalState(roots, candidate);
  throw new Error('accepted stale evidence');
} catch (error) {
  expect(error).toBeInstanceOf(FinalStateError);
  expect((error as FinalStateError).code).toBe('final_state_mismatch');
}
```

  Independently test same-size byte rewrites, raw-log addition/deletion, a new
  nested descendant log, document addition/deletion, non-Markdown artifact
  changes, and file replacement by renaming a different inode with identical
  bytes. Check unchanged nested/empty directories and UTF-8/CRLF bytes. Root
  ordering must not affect equality. Missing roots, symlinked roots/ancestors,
  files or subdirectories, and non-regular entries must fail without reading
  their target bytes. A malformed candidate, omitted root/node or duplicate path
  must fail. Invalid/caller-mismatched candidates must not select source paths.

  For every mutation case assert that the original candidate and changed source
  bytes remain unchanged by verification. Neither function writes source or
  candidate files. A changing source is not silently retried into success.

- [ ] **Step 2: Run the failing contract tests.**

```bash
bun test test/observer-final-state.test.ts
```

  Expect missing module/export before implementation. After exports exist,
  reproduce the late-append assertion against a deliberately absent comparison
  before completing the verifier, so the regression tests observable behavior.

- [ ] **Step 3: Implement one shared inventory reader.** Validate supplied roots
  as absolute paths with unique IDs before traversal. Reject symbolic links in
  each existing absolute path component. Traverse names in lexical code-unit
  order; do not use locale ordering. Transcript roots inventory every directory
  and regular `.jsonl` file, including new descendant files. Artifact roots
  inventory every directory and regular file, excluding entries named `.git`
  and `node_modules` exactly as existing observer inventory does. Do not accept
  symlink/special entries by hiding them behind an extension filter.

  Record and recheck directory device/inode/type and sorted entry names around
  traversal. For each included file, take bigint `lstatSync` before and after
  `readPinnedNoFollowBytes(root.path, relativeParts, 'observer source', true)`.
  Reject changes in device/inode/type, size, mtime or ctime during that read;
  hash the returned bytes and record byte length. The reused pinned byte reader
  refuses symlink substitutions through any path component. Never use a
  candidate-provided path to perform a read. Map missing/unreadable sources to
  `source_unavailable`, detected observation races to `source_changed`, and
  invalid caller/candidate values to `invalid_state`; keep raw data out of errors.
  Close all opened descriptors through the existing helper.

  Capture two independently traversed observations. Return the second only if
  their canonical inventories agree; otherwise throw `source_changed`. This
  detects instability during candidate capture without claiming process exit.
  A stopped-container caller still must supply the external termination proof.

```ts
export function verifyFinalState(
  roots: readonly FinalStateRoot[], candidate: FinalState,
): void {
  const expected = validateState(candidate);
  const rootDescriptions = validateRoots(roots)
    .map(({ id, kind }) => ({ id, kind }));
  if (!equalRoots(expected.roots, rootDescriptions)) {
    throw new FinalStateError('invalid_state');
  }
  const actual = captureFinalState(roots);
  if (!equalState(expected, actual)) {
    throw new FinalStateError('final_state_mismatch');
  }
}
```

  Implement `validateState`, `validateRoots`, `equalRoots`, and `equalState` as
  private helpers in this file. Validation canonicalizes array ordering by
  root ID then relative path before comparison; it never drops nodes. Equality
  includes every defined field. Paths remain relative in returned inventory;
  device/inode are provenance and final-state checks, never paths for replay.

- [ ] **Step 4: Run focused checks and self-review.**

```bash
bun test test/observer-final-state.test.ts test/observer-raw.test.ts
bun run lint
bun run typecheck
git diff --check
```

  Record commands and actual results. Verify no production imports activate this
  helper and that raw adapters, V1 paths and publisher remain unchanged. Use a
  child fixture program to append only after the candidate has been captured;
  wait for its exit and assert rejection. The test must run the program and check
  filesystem behavior, not compare generated command strings. This is local
  process-ordering evidence, not Docker shutdown qualification.

- [ ] **Step 5: Commit, review, and record the boundary.**

```bash
git add src/experiments/observer/final-state.ts test/observer-final-state.test.ts
git commit -m "feat: verify observer source inventories against final state"
```

  Include intent, late-write refusal, shared traversal and inactive integration
  boundary in the commit body. Obtain the task review and scoped fixes under SDD.
  The integration owner runs `bun run check` and `bun run quorum check` on the
  integrated source and records results in the PR2258 experiment log.

## Subsequent integration acceptance

The complete V2 binding/candidate producer must authenticate these inventory
fingerprints against the actual bundled source bytes; a standalone inventory
file is not proof of that relationship. Publisher integration must independently
require the observer, verify the exact stopped attempt, derive roots from its
trusted binding, invoke this check, and only then call existing manifest
verification/publication. Missing candidates and source mismatches must reach
existing explicit missing-evidence accounting without rename or repair.

Keep those integration tests with the producer/publisher changes: unchanged
publication; candidate omission; wrong binding; late writer refused before
rename; hard-kill partial output; unchanged strict score; copied-bundle replay
with home/staging absent. Actual six-container Linux qualification remains a
separate authorized gate. No supervisor design or implementation is prerequisite.
