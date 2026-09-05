# PR 2258 Raw Observer Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Review Task 1 first; then run Tasks 2 and 3 in parallel in isolated worktrees with independent task reviews. The integration owner runs the full repository gate once after integration.

**Status:** Source slice complete at `de769cca`; all task reviews and the final
scoped fix review passed. Final verification: 3,599 core passes, 14 qualification
skips, 144 dashboard passes, 88 scenario checks, no failures. The modules remain
inactive; runtime integration and qualification are separate work. Full receipts
and implementation decisions are recorded in
[the experiment log](../../experiments/2026-09-05-pr2258-parallel-comparison.md).

**Goal:** Build independently testable, offline Codex and Claude raw transcript indexes that preserve original chronology and expose unresolved identity and approval provenance honestly.

**Architecture:** Both adapters take a supplied source description and raw bytes, parse the complete stream once, and maintain replay/call state inside that pass. They return the same strict schema-version-2 index with immutable source/line/block anchors; prefix verification operates on the actual bytes. These modules have no runtime consumers in this increment.

**Tech Stack:** TypeScript, Bun >=1.3.13, existing Zod dependency, Node crypto, fatal UTF-8 decoding; no new dependencies.

**Spec:** [Approved parallel comparison design](../specs/2026-09-05-pr2258-parallel-comparison-design.md), especially Raw chronology adapters and Capture, finalization, and replay. Source inspected at `dc37c08798014fbaa20b2f46b4bb0aa4f3002f16`.

## Global Constraints

- Drew approved source implementation; this plan does not authorize live runs, Linux/Docker work, installed changes, credentials, or spending.
- Keep `src/experiments/brainstorming-evidence.ts`, `brainstorming-input-capture.ts`, existing normalizers, current CLI/scenario routing, and historical V1 files unchanged.
- Implement only source identity, anchors, prefixes, index entries, and the raw parsing/indexing functions that consume them. Do not create binding, document, bundle, review, scoring, report, or qualification registry schemas in this slice.
- No filesystem access or home/session discovery in the implementation. Tests may read checked-in fixtures. Supplied expected identity fields are comparisons, never proof of parenthood or user provenance.
- No ATIF normalization, timestamp ordering, public incremental append API, compatibility reader/converter, or generic adapter framework.
- Preserve complete physical call payloads. One physical call is the index's authoritative classification unit, including an entire composite script. This slice does not emit optional logical projections: adding them is unnecessary for indexing and would introduce a second classification obligation before the scorer exists.
- Unknown record/block variants, malformed recognized records, conflicting identities, orphan results, malformed JSONL, and nonempty reviewed suffixes fail explicitly. Never return a plausible partial index after an error.
- Claude SDK fixture fields establish shape and claims only. Parent and external-user eligibility remain unresolved unless directly disproved; this increment does not claim current Claude TUI qualification.
- General descendant chronology is out of scope. A descendant source remains separate and cannot supply parent approvals. No guessed call-to-child join or termination edge.
- Keep source identity and eligibility uncertainty distinct from malformed evidence. Validly parsed but unresolved provenance is returned explicitly; an observer consumer must reject it as approval authority.

## Delivery and files

| Task | Files | Independently reviewable result |
|---|---|---|
| 1 | `src/experiments/observer/contracts.ts`, `raw.ts`, `test/observer-raw.test.ts` | Strict shared types, complete-byte JSONL parsing, prefix creation/verification, empty-suffix policy |
| 2 | `src/experiments/observer/codex.ts`, `test/observer-codex.test.ts` | Stateful full-stream Codex index over supplied bytes |
| 3 | `src/experiments/observer/claude.ts`, `test/observer-claude.test.ts` | Stateful full-stream Claude index with explicit unresolved provenance |

Each adapter parses once. After `const rows = parseCompleteJsonl(source, raw)`,
construct its prefix from that same validated input using Node crypto:

```ts
const prefix: RawPrefix = {
  source_id: source.source_id,
  bytes: raw.byteLength,
  sha256: createHash('sha256').update(raw).digest('hex'),
  after_line: rows.length,
};
```

Import `createHash` from `node:crypto`. Do not call `createRawPrefix` in adapter
implementation because that independently validates and reparses the stream.
Test each adapter's computed prefix against `createRawPrefix` on representative
raw bytes, including multibyte text and CRLF. The shared byte-verification API
stays unchanged; this small repeated assembly avoids a second full parse.

Use direct imports from the named modules; no barrel or registry is necessary. Tasks 2 and 3 consume the reviewed Task 1 interface unchanged and own disjoint adapter/test files. Changes to that shared interface belong to the integration owner and require another contract review before proceeding.

### Task 1: Shared raw contracts, parser, and byte-prefix verification

**Files:**

- Create: `src/experiments/observer/contracts.ts`
- Create: `src/experiments/observer/raw.ts`
- Test: `test/observer-raw.test.ts`

**Interfaces:**

The following is the complete public domain surface for this increment. Define strict Zod schemas with matching names ending in `Schema` for `RawSource`, `RawAnchor`, `RawPrefix`, `SourceIdentity`, and `RawIndex`; use inferred types or ensure these types exactly match the schemas. Raw parsed JSON is opaque JSON data, not a strict record-format schema. Every index domain object is strict.

```ts
export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [key: string]: JsonValue };

export interface RawSource {
  source_id: string;
  runtime: 'codex' | 'claude';
  expected_session_id: string;
  expected_cwd: string;
  expected_cli_version: string;
}

export interface RawAnchor {
  source_id: string;
  line: number; // one-based physical JSONL line
  block: number | null; // zero-based content-array position; null for scalar/row
}

export interface RawPrefix {
  source_id: string;
  bytes: number;
  sha256: string;
  after_line: number;
}

export interface SourceIdentity {
  session_id: string | null;
  cwd: string | null;
  cli_version: string | null;
  conversation: 'parent' | 'descendant' | 'unresolved';
  evidence: RawAnchor[];
}

export type RawEntry =
  | {
      kind: 'message'; anchor: RawAnchor; role: 'assistant' | 'user';
      text: string; message_id: string | null;
      claimed_origin: 'external' | 'internal' | 'unclaimed';
      approval_eligibility: 'eligible' | 'ineligible' | 'unresolved';
    }
  | {
      kind: 'call'; anchor: RawAnchor; call_id: string;
      native_call_id: string | null; name: string; payload: JsonValue;
    }
  | {
      kind: 'result'; anchor: RawAnchor; call_id: string;
      call_anchor: RawAnchor; payload: JsonValue;
    }
  | {
      kind: 'replay'; anchor: RawAnchor; canonical_anchor: RawAnchor;
    }
  | {
      kind: 'non_action'; anchor: RawAnchor; record_type: string;
    };

export interface RawIndex {
  schema_version: 2;
  source: RawSource;
  identity: SourceIdentity;
  prefix: RawPrefix;
  entries: RawEntry[];
}

export type EvidenceErrorCode =
  | 'invalid_source' | 'invalid_utf8' | 'incomplete_jsonl'
  | 'invalid_jsonl' | 'invalid_record' | 'unknown_record'
  | 'identity_conflict' | 'replay_conflict' | 'orphan_result'
  | 'prefix_mismatch' | 'unreviewed_suffix';

export class ObserverEvidenceError extends Error {
  readonly code: EvidenceErrorCode;
  readonly anchor: RawAnchor | null;
  constructor(code: EvidenceErrorCode, message: string,
              anchor: RawAnchor | null = null);
}

export interface RawRow {
  anchor: RawAnchor;
  byte_start: number;
  byte_end: number; // exclusive, includes LF
  value: { [key: string]: JsonValue };
}

export function parseCompleteJsonl(source: RawSource,
  raw: Uint8Array): RawRow[];
export function createRawPrefix(source: RawSource,
  raw: Uint8Array): RawPrefix;
export function verifyRawPrefix(source: RawSource,
  raw: Uint8Array, prefix: RawPrefix): void;
export function verifyReviewedSuffix(source: RawSource,
  raw: Uint8Array, reviewed: RawPrefix): void;
export function canonicalJson(value: JsonValue): string;
```

`ObserverEvidenceError` lives in `contracts.ts`; the four byte functions and canonical JSON comparison live in `raw.ts`. Adapters export functions with the identical parameter/return shape:

```ts
export function indexCodexTranscript(source: RawSource,
  raw: Uint8Array): RawIndex;
export function indexClaudeTranscript(source: RawSource,
  raw: Uint8Array): RawIndex;
```

- [x] **Step 1: Write parser and prefix failures before implementation.** Use `TextEncoder`, not string character counts. Include this fixture and checks:

```ts
const source = {
  source_id: 'main', runtime: 'codex' as const,
  expected_session_id: 's', expected_cwd: '/fixture',
  expected_cli_version: 'fixture',
};
const encode = (text: string) => new TextEncoder().encode(text);
const raw = encode('{"text":"é"}\r\n{"text":"second"}\n');

test('anchors and boundaries count raw bytes and physical lines', () => {
  const rows = parseCompleteJsonl(source, raw);
  expect(rows.map(row => row.anchor)).toEqual([
    { source_id: 'main', line: 1, block: null },
    { source_id: 'main', line: 2, block: null },
  ]);
  expect(rows[0]!.byte_end).toBe(encode('{"text":"é"}\r\n').length);
  expect(rows[1]!.byte_start).toBe(rows[0]!.byte_end);
  expect(rows[1]!.byte_end).toBe(raw.length);
});

test('prefix verification permits append; suffix policy does not', () => {
  const prefixBytes = encode('{"text":"é"}\r\n');
  const prefix = createRawPrefix(source, prefixBytes);
  expect(() => verifyRawPrefix(source, raw, prefix)).not.toThrow();
  expect(() => verifyReviewedSuffix(source, raw, prefix))
    .toThrow(ObserverEvidenceError);
  expect(() => verifyReviewedSuffix(source, prefixBytes, prefix)).not.toThrow();
});

test.each([
  encode('{"a":1}'), encode('{}\n\n'), encode('null\n'),
  encode('[]\n'), encode('{broken}\n'),
  new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 10]),
])('incomplete, invalid, and non-object rows reject', raw => {
  expect(() => parseCompleteJsonl(source, raw)).toThrow(ObserverEvidenceError);
});
```

Also assert: wrong source ID, digest, byte count, line count, truncation, a prefix ending inside `é`, UTF-8 BOM, and changed early bytes reject. Empty input returns zero rows and a zero-byte/zero-line SHA-256 prefix; the adapters return unresolved identity for it. Reject non-finite numbers anywhere in parsed JSON rather than letting JSON stringify turn them into null.

- [x] **Step 2: Run `bun test test/observer-raw.test.ts`.** Expect missing-export/module failures before implementing Task 1.

- [x] **Step 3: Implement strict contracts and complete-byte parsing.** Require nonempty source identity strings; require nonnegative safe integers for bytes/line counts, positive safe integers for anchor lines, nonnegative safe integers or null for block, and lowercase 64-hex digests. Require matching source IDs across the index, anchors, prefixes, result links, and replay links. Reject duplicate entry anchors, forward replay links, replay links that do not name an existing canonical non-replay entry, result links that do not identify an earlier call, and eligible assistant messages. Do not infer runtime from data or filenames.

Whole-row UUID/message replay emits one alias per original block, each pointing directly to that block's canonical non-replay entry. The replay retains the current line and original block index; scalar or metadata rows use `block: null`. A row containing both new text and a replayed call stores a canonical target for each slot, so later UUID replay points directly to the original text/call entries, never to another replay. An exactly empty content array produces a validated `non_action` entry at the row anchor with record type `assistant.empty` or `user.empty`. Do not create extra row markers for records that contain actions. Test multi-block row replay against schema validation, not just adapter output.

Use this parsing sequence, preserving bytes rather than re-encoding decoded text for boundaries:

```ts
if (raw.length > 0 && raw.at(-1) !== 10) {
  throw new ObserverEvidenceError('incomplete_jsonl', 'JSONL must end at LF.');
}
if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
  throw new ObserverEvidenceError('invalid_utf8', 'JSONL must not start with BOM.');
}
const decoder = new TextDecoder('utf-8', { fatal: true });
const rows: RawRow[] = [];
let start = 0;
for (let end = 0; end < raw.length; end++) {
  if (raw[end] !== 10) continue;
  const anchor = { source_id: source.source_id, line: rows.length + 1, block: null };
  // Decode raw.subarray(start, end) with decoder. Map decoding failures to
  // invalid_utf8; map JSON.parse failures to invalid_jsonl at this anchor.
  // Require a non-null non-array object and recursively finite JSON numbers.
  // Push { anchor, byte_start: start, byte_end: end + 1, value }.
  start = end + 1;
}
```

The comments in this algorithm specify the complete error mapping and row creation; implement those operations directly. CR preceding LF remains part of the raw line; JSON parsing accepts it as whitespace. Blank physical lines are invalid, so line numbers cannot silently collapse. Do not include raw content in error messages.

Implement the shared replay comparison without mutating parsed values:

```ts
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
```

Test equal objects with different key order, unequal array order, unequal text, and nested values. Call it only with validated finite JSON. No timestamp or provenance fields are discarded when comparing duplicate raw rows.

- [x] **Step 4: Implement byte-prefix verification and the closed initial suffix policy.** SHA-256 uses `createHash('sha256').update(raw).digest('hex')`. `createRawPrefix` validates the entire bytes and counts parsed rows. `verifyRawPrefix` validates the supplied schema, matching source ID, length bound, and exact prefix bytes by calling `createRawPrefix(source, raw.subarray(0, prefix.bytes))`; all four fields must equal. Map mismatch or invalid claimed prefix to `prefix_mismatch`, retaining no fabricated replacement prefix. `verifyReviewedSuffix` first verifies the prefix, then rejects any `raw.length !== reviewed.bytes` with `unreviewed_suffix`. This intentionally accepts no nonempty suffix, even a familiar telemetry row; a later qualified grammar is separate source work.

- [x] **Step 5: Run focused verification and review the contract.** Run `bun test test/observer-raw.test.ts` and `bun run typecheck`; expect success. Review safe-integer validation, byte-faithful hashing, no partial JSONL acceptance, and absence of filesystem imports.

- [x] **Step 6: Commit the independently tested contract.** Stage only the three Task 1 files. Use summary `feat: define strict raw observer index contracts` and a body explaining byte boundaries, immutable anchors, unresolved provenance, and intentional empty-suffix policy. Do not skip hooks. Task 2/3 implementation starts only after Task 1's public contract review.

### Task 2: Stateful Codex raw index

**Files:**

- Create: `src/experiments/observer/codex.ts`
- Test: `test/observer-codex.test.ts`
- Read only: `src/normalize/codex.ts`, `test/normalize.codex.test.ts`, `test/fixtures/codex-56-exec.slice.jsonl`, `test/brainstorming-evidence.test.ts`

**Interfaces:** Consume all Task 1 types and `parseCompleteJsonl`/`createRawPrefix`/`canonicalJson`. Export exactly `indexCodexTranscript(source: RawSource, raw: Uint8Array): RawIndex`. Do not change existing normalizers to share projection helpers: physical payload indexing makes that dependency unnecessary.

- [x] **Step 1: Write tests for physical calls, results, and immutable prefix chronology.** Test fixtures are deliberately synthetic; the build label `fixture` is never a qualification receipt.

```ts
const source = {
  source_id: 'main', runtime: 'codex' as const,
  expected_session_id: 's', expected_cwd: '/fixture',
  expected_cli_version: 'fixture',
};
const bytes = (rows: unknown[]) => new TextEncoder()
  .encode(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const meta = { type: 'session_meta', payload: {
  id: 's', cwd: '/fixture', cli_version: 'fixture', source: 'cli',
} };
const call = { type: 'response_item', payload: {
  type: 'custom_tool_call', name: 'exec', call_id: 'c',
  input: 'await tools.exec_command({cmd:"pwd"}); await unknownEffect();',
} };
const result = { type: 'response_item', payload: {
  type: 'custom_tool_call_output', call_id: 'c', output: 'done',
} };

test('full physical scripts stay intact and results stay later', () => {
  const prefix = indexCodexTranscript(source, bytes([meta, call]));
  const full = indexCodexTranscript(source, bytes([meta, call, result, call]));
  expect(full.entries.filter(entry => entry.anchor.line <= 2)).toEqual(prefix.entries);
  expect(full.entries.filter(entry => entry.kind === 'call')).toEqual([
    { kind: 'call', anchor: { source_id: 'main', line: 2, block: null },
      call_id: 'native:c', native_call_id: 'c', name: 'exec', payload: call.payload },
  ]);
  expect(full.entries.find(entry => entry.kind === 'result')).toMatchObject({
    anchor: { source_id: 'main', line: 3, block: null },
    call_anchor: { source_id: 'main', line: 2, block: null },
  });
  expect(full.entries.at(-1)).toEqual({
    kind: 'replay', anchor: { source_id: 'main', line: 4, block: null },
    canonical_anchor: { source_id: 'main', line: 2, block: null },
  });
});
```

Add explicit cases: duplicate native call with changed arguments rejects; result without a prior call rejects; repeated result with changed payload rejects; identical ID-less native calls on two lines remain two calls; assistant/user content blocks on one row retain separate block anchors; unknown `_call`, unknown `event_msg` subtype, and unknown content block reject. Test `function_call`, `custom_tool_call`, `local_shell_call`, `web_search_call`, `tool_search_call` and their supported result records as physical payloads, not rendered-script regex matches.

- [x] **Step 2: Run `bun test test/observer-codex.test.ts`.** Expect missing module/export failure.

- [x] **Step 3: Implement one forward pass with source-local maps.** Reject `source.runtime !== 'codex'`. Validate every present identity-bearing field against the supplied expected identity; missing identity remains unresolved, conflicting fields fail `identity_conflict`. Recognize `session_meta.payload.id` (and require equality when `session_id` is also present), `cwd`, `cli_version`, and `source`. Qualified historical parent shape `source: 'cli'` plus matching complete identity establishes `parent`; an object with `subagent` establishes `descendant`. Unknown source variants remain unresolved. A second metadata record cannot silently change any established field. Collect identity evidence at the metadata row's anchor.

Parenthood observed after a message must not retroactively make that earlier message eligible. Use identity established at the message's own position. A descendant source's user blocks are ineligible. A canonical parent `response_item.payload.type: 'message'` with explicit `role: 'user'` and `input_text` blocks uses `claimed_origin: 'external'`, `approval_eligibility: 'eligible'`; missing identity yields unresolved eligibility. Assistant `output_text` blocks are always ineligible. Never default a missing role to user. Never treat mirrored `event_msg` messages as approvals.

Use this exact replay identity convention:

```ts
const nativeId = typeof payload.call_id === 'string' && payload.call_id.length
  ? payload.call_id : null;
const callId = nativeId === null
  ? `anchor:${JSON.stringify([anchor.source_id, anchor.line, anchor.block])}`
  : `native:${nativeId}`;
```

The separate `native:`/`anchor:` namespaces cannot collide. Use Task 1's `canonicalJson` for replay comparisons; no timestamp field is silently omitted from an identity-bearing payload. For a repeated native call ID compare the entire physical call payload; identical payload produces a replay entry, different payload throws `replay_conflict`. ID-less calls are never deduplicated by content. Results link by native call ID and retain their original anchor; identical result payload replays, conflicting result payload rejects.

For `function_call` and `custom_tool_call`, the index call name is the explicit `payload.name`. For native `local_shell_call`, `web_search_call`, and `tool_search_call`, use the raw type discriminant verbatim as the call name. Do not substitute normalized names such as Bash or ToolSearch. The complete physical payload remains available to later classification.

Recognized record grammar for this inactive index is closed at record/block discriminants:

| Raw form | Index behavior |
|---|---|
| `session_meta` with valid object payload | Identity checks and `non_action` entry |
| `response_item / message` | Explicit user/assistant roles and recognized text blocks only; system/developer text is `non_action`; unknown role/block rejects |
| `response_item / function_call` | Require nonempty name/call ID and a present `arguments` member that is a non-null non-array object or a string parsing to that shape; preserve the original entire payload |
| `response_item / custom_tool_call` | Require nonempty name/call ID and string input; preserve the entire payload/script |
| `response_item / local_shell_call` | Require object action with command array of strings; preserve payload; ID-less anchor ID |
| `response_item / web_search_call` | Require object action and nonempty action type; preserve payload; ID-less anchor ID |
| `response_item / tool_search_call` | Require nonempty call ID and present `arguments` using the same object/JSON-object-string validation; preserve payload |
| `response_item / function_call_output`, `custom_tool_call_output` | Require nonempty `call_id` and present `output` member; preserve full payload and link to an earlier call |
| `response_item / tool_search_output` | Require nonempty `call_id` and present `tools` member, exactly as consumed by `src/normalize/codex.ts:745-748`; preserve full payload and link to an earlier call |
| Any other top-level type, payload type, or message block | Throw `unknown_record` |

This first grammar deliberately does not claim complete rollout coverage: `turn_context`, reasoning, token events, mirrored messages, and all other variants reject pending explicit contracts. No broad non-action category hides them. Ordinary metadata/call payload fields remain available unchanged as raw bytes; accepted calls also retain the complete physical payload in the index. The grammar does not execute or classify the semantic effects of tool arguments.

- [x] **Step 4: Add replay, identity, and shape regressions.** An exact repeat of a message payload bearing a stable `id` emits one replay per original content block, with the current line and the same block index, pointing to the original canonical block anchor. Scalar entries retain null block positions. Conflicting payload for that ID rejects. ID-less messages are distinct; repeated text is not replay proof. Keep this map separate from call IDs. A result cannot establish a new user message. Missing parent metadata, child metadata, wrong expected session/cwd/build, missing message role, missing arguments, null/array/number arguments, and invalid JSON-object argument strings each have explicit assertions for unresolved eligibility or the required error. A `tool_search_output` carrying only `output` instead of `tools` rejects.

Read the checked-in Codex slice as shape evidence: assert that selected original `session_meta` and `custom_tool_call` rows retain the original script payload after indexing a test input assembled from those rows. Clearly label this test as a selected-row shape test, not full captured-stream qualification. Preserve the slice's declared build as the expected build in that test. Assert that attempting the entire existing slice rejects its first unsupported variant, with that raw anchor, rather than silently omitting it.

- [x] **Step 5: Run the task gate.** Run `bun test test/observer-raw.test.ts test/observer-codex.test.ts test/brainstorming-evidence.test.ts test/normalize.codex.test.ts` and `bun run typecheck`. Expect all assertions to pass. Review that unknown composite effects remain visible in the physical script, no script is executed, every result is anchored later, and no V1 runtime import changes occurred.

- [x] **Step 6: Commit.** Stage only the two Task 2 files. Use summary `feat: index Codex observer raw chronology` and a body describing original anchors, native-call replay conflicts, complete physical scripts, and the deliberately incomplete inactive grammar. Do not skip hooks.

### Task 3: Stateful Claude raw index with honest provenance

**Files:**

- Create: `src/experiments/observer/claude.ts`
- Test: `test/observer-claude.test.ts`
- Read only: `src/normalize/claude.ts`, `test/normalize.claude.test.ts`, `test/fixtures/claude-2.1.177-real.jsonl`, `test/fixtures/claude-2.1.177-with-tooluse.jsonl`

**Interfaces:** Consume Task 1 domain types, `parseCompleteJsonl`, and `canonicalJson`. Compute the prefix from validated rows/bytes; use `createRawPrefix` only as a test oracle. Export exactly `indexClaudeTranscript(source: RawSource, raw: Uint8Array): RawIndex`. No adapter activation or readiness boolean is exported.

- [x] **Step 1: Write split-message and replay tests first.** Use distinct UUIDs for split rows sharing a message ID. The later call and result must remain after the intervening user row.

```ts
const source = {
  source_id: 'main', runtime: 'claude' as const,
  expected_session_id: 's', expected_cwd: '/fixture',
  expected_cli_version: 'fixture',
};
const bytes = (rows: unknown[]) => new TextEncoder()
  .encode(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const common = { sessionId: 's', cwd: '/fixture', version: 'fixture',
  isSidechain: false, parentUuid: null };
const text = { ...common, uuid: 'a', type: 'assistant', message: {
  id: 'm', role: 'assistant', content: [{ type: 'text', text: 'Review this.' }],
} };
const user = { ...common, uuid: 'u', userType: 'external', type: 'user',
  message: { role: 'user', content: 'Approved.' } };
const call = { ...common, uuid: 'b', type: 'assistant', message: {
  id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 'c',
    name: 'Write', input: { file_path: 'app.ts', content: 'product' } }],
} };

test('a repeated message ID never pulls later blocks into an earlier row', () => {
  const prefix = indexClaudeTranscript(source, bytes([text, user]));
  const full = indexClaudeTranscript(source, bytes([text, user, call, user]));
  expect(full.entries.filter(entry => entry.anchor.line <= 2)).toEqual(prefix.entries);
  expect(full.entries.find(entry => entry.kind === 'call')).toMatchObject({
    anchor: { source_id: 'main', line: 3, block: 0 }, native_call_id: 'c',
  });
  expect(full.entries.filter(entry => entry.kind === 'message' && entry.role === 'user'))
    .toHaveLength(1);
  expect(full.entries.at(-1)).toEqual({
    kind: 'replay', anchor: { source_id: 'main', line: 4, block: null },
    canonical_anchor: { source_id: 'main', line: 2, block: null },
  });
  expect(full.identity.conversation).toBe('unresolved');
  expect(full.entries.find(entry => entry.kind === 'message' && entry.role === 'user'))
    .toMatchObject({ claimed_origin: 'external', approval_eligibility: 'unresolved' });
});
```

Add conflict tests for repeated UUID with altered content, repeated tool-use ID with altered input, and result payload conflicts. Add multiple block roles on one row, result-only user records, an external-claimed attachment, internal-claimed text, a summary marker, queue prefixes, sidechains, and unknown/action-bearing variants. All are behavioral assertions over indexed entries or typed errors, not regex assertions over large rendered strings.

Test the exact per-block replay contract, including schema validation:

```ts
test('UUID replay aliases each original block rather than an absent row entry', () => {
  const mixed = { ...common, uuid: 'mixed', type: 'assistant', message: {
    id: 'mixed-message', role: 'assistant', content: [
      { type: 'text', text: 'Reading.' },
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'spec.md' } },
    ],
  } };
  const index = indexClaudeTranscript(source, bytes([mixed, mixed]));
  expect(RawIndexSchema.safeParse(index).success).toBe(true);
  expect(index.entries.filter(entry => entry.kind === 'replay')).toEqual([
    { kind: 'replay', anchor: { source_id: 'main', line: 2, block: 0 },
      canonical_anchor: { source_id: 'main', line: 1, block: 0 } },
    { kind: 'replay', anchor: { source_id: 'main', line: 2, block: 1 },
      canonical_anchor: { source_id: 'main', line: 1, block: 1 } },
  ]);
  const invalid = structuredClone(index);
  const alias = invalid.entries.find(entry => entry.kind === 'replay')!;
  if (alias.kind !== 'replay') throw new Error('Expected replay fixture.');
  alias.canonical_anchor.block = null;
  expect(RawIndexSchema.safeParse(invalid).success).toBe(false);
});
```

- [x] **Step 2: Run `bun test test/observer-claude.test.ts`.** Expect the missing module/export failure.

- [x] **Step 3: Implement UUID, tool-use, and result state in a single forward pass.** Reject the wrong supplied runtime. Every supported row with a nonempty UUID is checked against a UUID map before block processing. Store recursively canonicalized complete row value and the canonical target for each emitted block/null slot after processing. An exact replay emits one `replay` per stored slot at the current line and same block index, each targeting an existing original non-replay entry, and skips block processing; a conflict throws `replay_conflict`. Do not ignore timestamp, parent, session, or provenance differences on duplicate UUIDs. Rows without UUID are processed individually; do not infer replay from text equality.

Treat `message.id` solely as a label copied to message entries. Never use it as a mutable turn accumulator or a deduplication key. Each new text block keeps the current line and block position. Tool IDs use the same `native:<id>` naming as Codex and are deduplicated across the full stream using the complete tool-use block. A repeated tool-use block under a different UUID points to its original block anchor. A changed name/input/payload for that ID fails. A result requires an earlier matching tool-use ID; its own block position and full result block stay intact. Do not attach results by moving their contents into call entries. Preserve row-level `toolUseResult` in result payload as `{ block: originalBlock, tool_use_result: row.toolUseResult ?? null }` so success evidence is not lost. Use that complete result payload for replay/conflict checks.

- [x] **Step 4: Implement identity and message-origin interpretation without guessing TUI provenance.** Inspect every recognized identity-bearing row rather than the first row. Verify all present `sessionId`, `cwd`, and `version` values against source expectations and against earlier observed values; contradictions throw `identity_conflict`. Queue rows may contribute a session claim, but cannot establish parenthood or approvals. `isSidechain: true` or a nonempty `agentId` positively marks final source identity as `descendant`. Each message retains the eligibility computed when its physical row was encountered. Later descendant evidence must not rewrite earlier entries; prefix invariance includes appending late sidechain/agent markers. `isSidechain: false`, matching cwd/session, and null `parentUuid` leave `conversation: 'unresolved'`. There is no `parent` outcome for Claude in this slice, because the supplied fixtures do not establish authoritative current-TUI parent selection.

On explicit user text blocks, `userType: 'external'` becomes `claimed_origin: 'external'`, not eligibility. `userType: 'internal'` becomes internal/ineligible. Missing or another user type is unclaimed/unresolved. User messages encountered after descendant identity is known are ineligible, regardless of the claim. Earlier unresolved entries remain unchanged; consumers must also check final source identity before using any source as approval authority. Recognized `isCompactSummary: true` user rows are non-action summary records and produce no approval message. The marker is a synthetic rejection invariant here, not proof of how the target CLI emits compaction. Assistant messages are always ineligible. Mixed tool-result/text user records emit separate entries. Preserve the observed row-level `userType` as `claimed_origin` on the text entry, including an external claim; its `approval_eligibility` remains unresolved unless a known internal/descendant rule makes it ineligible. A claim is not established provenance, and neither an adjacent result nor the row label can confer approval authority. Test the external-claim/unresolved-eligibility distinction explicitly. No message in this adapter is eligible yet.

The initial accepted grammar is explicitly limited:

| Raw form | Index behavior |
|---|---|
| `queue-operation` with `operation: enqueue | dequeue` | Non-action row; queue content is never canonical user text |
| `assistant` with matching explicit message role, string content or text/tool_use/thinking blocks | Text blocks become messages; `tool_use` requires nonempty ID/name and object input; thinking is non-action at its block anchor |
| `user` with matching explicit message role, string content or text/tool_result blocks | Text provenance rules above; results require matching prior calls |
| `user` with `isCompactSummary: true` and otherwise valid message shape | Summary-only non-action row; reject embedded tool-use/results instead of hiding them |
| `attachment` with object attachment and exact type `deferred_tools_delta` or `skill_listing` | Non-action row; never external-user text |
| `ai-title` with string `aiTitle` | Non-action row |
| Any other top-level type, block type, or attachment subtype | Throw `unknown_record` |

This grammar is enough to index the checked-in six-row 2.1.177 SDK shape fixture and synthetic chronological contracts. It deliberately rejects unspecified system/compaction/progress variants instead of blessing broad envelopes. Record acceptance in the reviewed index is not a suffix whitelist: Task 1 still rejects every nonempty suffix.

- [x] **Step 5: Add exact fixture and negative provenance checks.** Read `claude-2.1.177-real.jsonl` unchanged with these test expectations, copied from the inspected raw fixture:

```ts
const sdkSource: RawSource = {
  source_id: 'sdk-shape', runtime: 'claude',
  expected_session_id: 'f12c4b4d-de7b-45e3-b5c2-ea782aa9595e',
  expected_cwd: '/private/var/folders/43/prgnkdr95317fd_zbljq8thm0000gn/T/tmp.H3VT1AvRAc/wd',
  expected_cli_version: '2.1.177',
};
```

Assert queue rows precede its first canonical user row at physical line 3. Assert the log-declared SDK external claim remains unresolved and no eligible entry exists. Do not call this a TUI capture. `claude-2.1.177-with-tooluse.jsonl` lacks complete identity: use explicit synthetic expectations `{ source_id: 'tool-shape', runtime: 'claude', expected_session_id: 'fixture', expected_cwd: '/wd', expected_cli_version: 'fixture' }` and assert the returned observed session/build are null. These expectations deliberately do not claim the fixture exposed either missing value. Assert its text/call/result block anchors still index correctly, with identity unresolved.

Use this negative invariant over both fixtures and the synthetic main/child examples:

```ts
expect(index.entries.some(entry => entry.kind === 'message' &&
  entry.approval_eligibility === 'eligible')).toBe(false);
```

Also verify an old UUID approval replay after an intervening capture prefix creates only an alias, new text under an old message ID stays later, a child with the same cwd/session/null parent UUID cannot approve, unknown variants reject, and an orphan tool result is not transformed into user text. Deep-compare full-prefix entries before and after appending all supported replay/result/split-message suffix cases.

- [x] **Step 6: Run the independent Claude task gate.** Run `bun test test/observer-raw.test.ts test/observer-claude.test.ts test/normalize.claude.test.ts` and `bun run typecheck`. Record actual results. Task 3 does not require Task 2's unintegrated files and does not own the full repository gate. Existing unrelated failures must be reported with their exact failing tests; do not alter V1 code to make this increment appear complete.

- [x] **Step 7: Commit.** Stage only Task 3 files. Use summary `feat: index Claude observer raw chronology` and a body describing UUID/call replay, no retroactive message bundling, block-specific results, SDK fixture provenance limits, and the absence of runtime activation. Do not skip hooks.

## Review and subsequent integration boundary

After both adapter tasks pass their independent reviews and integrate with the reviewed Task 1 commit, the integration owner runs `bun run check` and `bun run quorum check` once. Record actual results and any conditional skips. The root already verified the source baseline; do not rerun baseline checks in adapter worktrees. Subsequent reruns need a new change or an unresolved failure to justify them.

The three task gates prove an offline parsing/index contract. Review the final diff to confirm that only the listed new observer modules/tests and an explicitly reviewed shared helper changed. Existing V1 behavior remains wired exactly as before. A new index is not a score and cannot authenticate a running process, home, receipt, or bundle.

The approved full design still requires source discovery and persistent binding, stable capture, complete qualified record coverage, verification of candidate evidence against final source state after the existing container-stop proof, frozen portable evidence, review/action semantics, scorer integration, and Linux/installed qualification. Those consumers receive separate plans under the amended container-boundary design and their qualification requirements. No new binding/document/bundle/review schemas are reserved here without consumers.

Claude readiness is explicitly unproven: the current fixture is an older SDK-entrypoint shape reference, and this plan intentionally leaves parent/external eligibility unresolved. Codex grammar completeness is also unproven for the newly activated instrument, despite preserving known physical calls and historical parent-message rules. Nonempty suffixes remain rejected until an exact build/dialect grammar is evidenced. These are recorded integration prerequisites, not reasons to manufacture provenance or activate a partially qualified observer.
