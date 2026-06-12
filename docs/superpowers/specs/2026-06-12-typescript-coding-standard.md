# Quorum TypeScript Coding Standard

**Date:** 2026-06-12
**Status:** Adopted — configs landed in `d44f3ff` (PRI-2207). Amended
2026-06-12 with two field findings from that adoption (`allowImportingTsExtensions`
in §2, `bunfig.toml` test scoping in §8).
**Author:** Vimes@b37163c3 (Fable 5), with Matt.
**Scope:** All TypeScript in `superpowers-evals` — `src/`, `test/`, and any
scripts. Builds on the umbrella spec
(`2026-06-12-quorum-typescript-rewrite-design.md`), which fixes Bun, zod,
Biome, and `tsc --noEmit`; this document specifies the rules those tools
enforce and the type discipline they cannot.
**Inspiration:** `~/Code/prime/brainstorm` (tsconfig/biome/lefthook), tightened
where greenfield status allows.

## 1. Principles

1. **Machine-enforced beats prose.** Every rule that *can* be a compiler flag
   or lint rule *is* one. Prose rules exist only where tooling cannot reach
   (boundary discipline, type design). A rule nobody enforces is a suggestion.
2. **`unknown` until proven.** Data is untyped until it crosses a zod schema.
   Type assertions are claims without evidence; schema parses are evidence.
3. **Make illegal states unrepresentable.** Quorum's domain is discriminated
   unions all the way down — three-valued verdicts, error stages, scheduler
   events, tool-call dialects. Model them as closed unions and let the
   compiler prove exhaustiveness.
4. **Zero baseline.** Greenfield means no grandfathered errors, no "warn"
   tier that scrolls by unread. Every rule is `error` or absent; the gate is
   green or the change doesn't land.

## 2. Compiler configuration

`tsc --noEmit` is the typechecker; Bun executes the TS directly. The compiler
is a linter here, so there is no cost to maximal strictness.

```jsonc
// tsconfig.json
{
  "include": ["src", "test"],
  "compilerOptions": {
    // Runtime: Bun
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "noEmit": true,
    "allowImportingTsExtensions": true,

    // Strictness — the full set, not just `strict`
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,

    // Syntax discipline
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "isolatedModules": true,

    // Pragmatics
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

Rationale for the non-obvious flags:

| Flag | Trap it closes |
|---|---|
| `allowImportingTsExtensions` | Bun resolves intra-project imports by their literal `.ts` specifiers, and `module: "Preserve"` does **not** enable those in tsc — verified on 5.9.3, where every intra-project import fails to typecheck without the explicit flag (field finding, `d44f3ff`). Safe because `noEmit` means tsc never has to rewrite the specifier. |
| `noUncheckedIndexedAccess` | `record[key]` is `T \| undefined`, not `T`. Session-log descent and `TOOL_MAP` lookups are exactly where unguarded indexing lies to you. |
| `exactOptionalPropertyTypes` | `{ x?: string }` no longer accepts `{ x: undefined }`. Keeps "absent" and "present-but-undefined" distinct — matters for `verdict.json` semantic parity, where a missing key and a `null`/`undefined` key are different bytes. |
| `noPropertyAccessFromIndexSignature` | Dotted access on index signatures looks like a typo-checked property but isn't. Forces `obj["key"]`, which reads as the unchecked lookup it is. |
| `verbatimModuleSyntax` | Forces `import type` for type-only imports; no ambiguity about what survives to runtime. |
| `erasableSyntaxOnly` | Compiler-level ban on `enum`, `namespace`, and constructor parameter properties — all TS syntax with runtime semantics. See §5.3. |
| `useUnknownInCatchVariables` | Implied by `strict`; called out because §6.3 builds on it. `catch (e)` binds `unknown`, never `any`. |

`noUnusedLocals`/`noUnusedParameters` are deliberately left to Biome, which
reports them with better fix-its and a single suppression mechanism.

## 3. Linter configuration

Biome 2.x, one tool for lint + format. Everything is `error`; there is no
`warn` tier (§1.4).

```jsonc
// biome.json
{
  "$schema": "https://biomejs.dev/schemas/2.4.5/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["src/**", "test/**", "*.ts", "*.json"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "javascript": {
    "formatter": { "quoteStyle": "single", "semicolons": "always" }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": {
        "noExplicitAny": "error",
        "noEvolvingTypes": "error",
        "noConsole": "error"
      },
      "correctness": {
        "noUnusedVariables": "error",
        "noUnusedImports": "error",
        "noUnusedFunctionParameters": "error"
      },
      "style": {
        "useConst": "error",
        "noEnum": "error",
        "noNonNullAssertion": "error",
        "noProcessEnv": "error",
        "noDefaultExport": "error",
        "useImportType": "error"
      },
      "nursery": {
        "noFloatingPromises": "error"
      }
    }
  },
  "overrides": [
    {
      // CLI and dashboard own the terminal/HTTP surface; console is product.
      "includes": ["src/cli/**", "src/dashboard/**"],
      "linter": { "rules": { "suspicious": { "noConsole": "off" } } }
    },
    {
      // The one env module (§6.5) reads process.env to validate it.
      "includes": ["src/env.ts"],
      "linter": { "rules": { "style": { "noProcessEnv": "off" } } }
    },
    {
      // Tests: non-null assertion allowed after explicit existence asserts.
      "includes": ["test/**"],
      "linter": { "rules": { "style": { "noNonNullAssertion": "off" } } }
    }
  ]
}
```

Notable calls, including where this diverges from brainstorm:

- **`noNonNullAssertion` is `error` in `src/`** (brainstorm: `warn`). `!` is
  `as` wearing a trench coat. Narrow, guard, or parse instead.
- **`noExplicitAny` stays on in tests** (brainstorm turns it off). Quorum's
  tests *are* the parity oracle — golden verdicts, replay differentials,
  recorded fixtures. An `any`-typed fixture can drift from the real shape and
  the diff still passes. Fixtures get zod-parsed like production input.
- **`noFloatingPromises`** — quorum is an async subprocess orchestrator; a
  dropped promise is a run that silently never tears down its tmux session or
  never writes its verdict. Biome's type inference here is partial, so this
  rule is necessary-not-sufficient; §6.4 carries the prose rule. (Promote out
  of `nursery` when Biome does.)
- **`noEvolvingTypes`** — bans `let x;` whose type "evolves" from implicit
  `any`. The third member of the any-smuggling family alongside `noExplicitAny`
  and `noImplicitAny`.
- **`noProcessEnv`** — all environment access goes through one zod-validated
  module (§6.5). This is how `required_env` discipline survives the port.
- **`noDefaultExport`** — named exports only; grep-ability and consistent
  import names across the codebase.

## 4. The `any` containment doctrine

`any` is not a type; it is an off switch for the typechecker that spreads
through everything it touches. The standard closes every door it comes in by:

| Door | Closed by |
|---|---|
| Written `any` | Biome `noExplicitAny` (src *and* test) |
| Implicit `any` | `strict` (`noImplicitAny`) |
| Evolving `any` (`let x;`) | Biome `noEvolvingTypes` |
| `catch (e)` | `useUnknownInCatchVariables` |
| `JSON.parse` / `Response.json()` returning `any` | §4.1 boundary rule — result is treated as `unknown` and zod-parsed before any property access |
| `as any`, `as unknown as T` | Banned outright, no exceptions, including tests (§5.2) |
| Untyped third-party surface | Wrap at the module boundary; the wrapper's exports are fully typed |
| `Function`, `{}`, `object` as catch-alls | Biome `noBannedTypes` (recommended set); use precise signatures or `unknown` |

`unknown` is the only legal "I don't know yet" type, and it is inert by
design: you cannot use it until you narrow it. Every `unknown` should have a
short lifetime ending at a zod parse or a type guard.

### 4.1 Boundary rule

Every byte that enters the process is `unknown` until a zod schema in
`src/contracts/` says otherwise. Boundaries, concretely:

- coding-agent YAML (`coding-agents/*.yaml`)
- gauntlet `result.json` and `usage.jsonl`
- session-log JSONL lines (per-dialect permissive schemas, then narrowing)
- check records emitted by `bin/` tools
- `verdict.json` (read side: dashboard, `show`, replay harness)
- environment variables (§6.5)
- anything off the network or out of a subprocess's stdout

Corollaries:

- **Schemas are the source of truth for types.** Boundary types come from
  `z.infer<typeof Schema>`. Never hand-write an interface that duplicates a
  schema; the duplicate *will* drift, and cost accounting is where silent
  field drift hurts most (the exact Go failure mode the umbrella spec rejected
  — don't reimplement it in TS).
- Use `.strict()`/`.passthrough()` deliberately per schema: strict for
  contracts we own (`verdict.json`), passthrough-then-narrow for dialects we
  don't (session logs).
- `JSON.parse` never flows directly into typed code. Parse, then
  `Schema.parse(...)` — or use `Schema.parse(JSON.parse(text))` as one
  motion.

## 5. Type design rules

### 5.1 Discriminated unions + exhaustiveness

Closed sets are discriminated unions, and every `switch` over a discriminant
ends in an exhaustiveness check:

```ts
function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}

switch (verdict.kind) {
  case 'pass': ...
  case 'fail': ...
  case 'indeterminate': ...
  default: assertNever(verdict);
}
```

When someone adds a ninth dialect or a new error stage, the compiler hands
them the list of every site that must care. This is the single highest-value
rule for this codebase: verdicts, `error.stage`, scheduler events, check
records, and normalized tool calls are all closed sets.

`assertNever` lives once in `src/contracts/` (or a tiny `src/invariant.ts`),
not copy-pasted.

### 5.2 Assertions

- `as const` — always fine; it's how literal unions get built.
- `satisfies` — preferred everywhere you'd reach for a type annotation that
  might widen, or an `as` that might lie. It checks without changing the type.
- `as T` — a review flag. Legal only when the compiler genuinely cannot know
  something you can prove locally (e.g., `Object.keys` round-trips), and each
  use carries a comment stating the invariant that makes it safe. If the
  invariant came from outside the process, that's not an `as`, that's a
  missing schema.
- `as any` / `as unknown as T` — banned, no exceptions, including tests.
- `value!` — banned in `src/` (Biome). In tests only, allowed after an
  explicit existence assertion (`expect(x).toBeDefined()` then `x!`).

### 5.3 No runtime-flavored TS syntax

`erasableSyntaxOnly` enforces this at the compiler:

- **No `enum`.** Use a literal union, plus an `as const` array when you need
  to iterate the members:

  ```ts
  const VERDICTS = ['pass', 'fail', 'indeterminate'] as const;
  type Verdict = (typeof VERDICTS)[number];
  ```

  (Or derive both from the zod schema: `z.enum(VERDICTS)`.)
- **No `namespace`**, no constructor parameter properties, no
  `import =`/`export =`, no decorators. Type-level TS only; runtime code is
  plain modern JS.

### 5.4 Functions and interfaces over class hierarchies

Pure logic (composer, economics, normalizers) is plain functions on plain
data. Behavior contracts (`CodingAgent`) are `interface`s; implementations
may be classes or object literals, whichever is simpler. No inheritance
deeper than "implements the interface" — extension happens through the
registry pattern the umbrella spec defines, not subclassing. `type` for
unions and compositions, `interface` for object contracts; don't churn
between them.

### 5.5 `undefined`, not `null` — except where JSON demands it

Internally, absence is `undefined` (optional properties, `T | undefined`
returns). `null` appears only in boundary contracts where the JSON on disk
actually says `null` — and the zod schema is what says so. Never let both
spellings of absence represent the same state in one type.

### 5.6 Readonly bias

`readonly` properties and `ReadonlyArray<T>`/`readonly T[]` on everything
that crosses a module boundary, by default. Mutation is an implementation
detail inside a function, not a communication channel between modules. The
scheduler is the one place with real shared mutable state — the spec puts it
all inside the dispatcher, and the types should make that fence visible.

## 6. Behavior rules

### 6.1 Expected failure is a value; a bug is an exception

Quorum's whole purpose is rendering judgment on failures, so "the run failed"
is not exceptional — it's output. Phases return discriminated results
(`{ ok: true, ... } | { ok: false, stage: ErrorStage, ... }`-shaped, per the
runner spec); `throw` is reserved for invariant violations and unrecoverable
environment problems. The orchestrator's error-stage mapping is a `switch`
over typed outcomes, not a `try/catch` taxonomy built on `instanceof` chains.

### 6.2 Every promise has an owner

Every promise is `await`ed, returned, or aggregated (`Promise.all` /
`Promise.allSettled`). Intentional fire-and-forget is written `void p` —
grep-able and rare; each one needs a comment saying why dropping it is safe.
Concurrent work that must be cleaned up (the antigravity rate-limit watcher
racing gauntlet) gets explicit join/teardown in a `finally`. Biome's
`noFloatingPromises` backstops this; it does not replace it.

### 6.3 Catch `unknown`, narrow, never swallow

`catch (err)` binds `unknown`. Narrow with `instanceof Error` (zod errors:
`instanceof z.ZodError`) before touching `.message`. Empty catch blocks are
banned; a deliberately-ignored error states why in a comment.

### 6.4 Subprocess and filesystem edges

Spawn results carry exit codes, signals, and partial output — model the
outcome as a typed value (§6.1), don't string-match stderr inline. Paths that
come from outside (run dirs, session-log locations) are validated to exist at
the boundary, not assumed deep in a phase.

### 6.5 One env module

`src/env.ts` is the only file that reads `process.env`/`Bun.env` (Biome
enforces). It zod-parses the environment once into a typed, frozen object;
everything else imports from it. Scenario-level `required_env` checks read
through the same module.

## 7. Module conventions

- **Named exports only** (Biome `noDefaultExport`).
- **`import type`** for type-only imports (`verbatimModuleSyntax` +
  `useImportType` auto-fix).
- **File names:** kebab-case. **Types:** PascalCase. **Values/functions:**
  camelCase. **True constants:** UPPER_SNAKE. The formatter owns everything
  else; style debates end at `biome format`.
- **One purpose per file**, per the umbrella spec's layout — a normalizer
  file exports one normalizer; `composer.ts` exports the composer. No
  `utils.ts` junk drawer; a helper either belongs to a domain module or to a
  named, single-concern module (`invariant.ts`).
- **Dependency direction:** `contracts/` imports nothing from sibling
  subsystems; everything imports `contracts/`. No import cycles — Biome's
  `noImportCycles` (project rule) gets enabled the first time it's free to.
- **Bun-primary:** prefer `Bun.spawn`, `Bun.file`, `bun:test`. Reach for
  `node:*` APIs when Bun lacks the surface; never reach for a third-party
  package when the runtime provides it (per the umbrella spec: Node compat
  where free, no gold-plating).

## 8. Tests

- `bun test`, colocated under `test/` per the umbrella layout.
- **Test discovery is scoped in `bunfig.toml`, not in script arguments:**

  ```toml
  [test]
  root = "test"
  ```

  `bun test <arg>` treats a positional as a filter *substring*, not a
  directory — `bun test test` does not mean "run the test/ dir." Without
  `root`, discovery scans the whole repo and picks up the 600+ stray
  `*.test.*` files that recorded eval runs leave under `results/` (field
  finding, `d44f3ff`). Do not "simplify" the bunfig away; it is the fence.
- Tests obey the same standard, with exactly one relaxation: `!` after an
  explicit existence assertion. No `any`, no `as any` — fixtures are parsed
  through the same `contracts/` schemas as production input, which makes
  fixture drift a test failure instead of a silent oracle corruption.
- Determinism rules from the scheduler spec generalize: injectable clock, no
  real sleeps, no wall-clock assertions, mock-gauntlet over live processes.

## 9. Suppression policy

Escape hatches exist; they are loud, justified, and counted.

- `// biome-ignore lint/<rule>: <reason>` — reason is mandatory (Biome
  rejects bare ignores). The reason states *why this case is safe*, not "lint
  was annoying."
- `// @ts-expect-error <reason>` — the only sanctioned TS suppression. It
  self-destructs when the error disappears. `@ts-ignore` is banned (Biome
  recommended set flags it).
- A suppression is a code-review item by definition. If the same suppression
  recurs three times, that's a standard bug — fix the rule or build the
  helper, don't keep paying the toll.

## 10. Enforcement

The standard is the gate, not the doc:

```jsonc
// package.json scripts
{
  "lint": "biome check .",
  "lint:fix": "biome check --write .",
  "typecheck": "tsc --noEmit",
  "test": "bun test",
  "check": "biome ci . && tsc --noEmit && bun test"
}
```

- **lefthook** (mirroring brainstorm): pre-commit = `biome check` on staged
  files + `tsc --noEmit`; pre-push = `bun test`.
- **CI safe-checks** (replacing the Python set in CLAUDE.md at cutover):
  `biome ci`, `tsc --noEmit`, `quorum check`, `bun test`.
- Tool versions (Bun, Biome, TypeScript) are pinned in `package.json` so the
  gate means the same thing on every machine. `.nvmrc`-equivalent: pin Bun via
  `packageManager`/`engines` and CI.

## 11. Explicitly rejected

Recorded so the debates don't get re-run:

- **ESLint + typescript-eslint** (for type-aware rules like
  `no-floating-promises` in full strength). Rejected for now: a second
  toolchain, slower, and Biome covers the bulk. Revisit only if floating
  promises actually bite through Biome's partial inference.
- **`any` in tests** (brainstorm's posture). Rejected: tests are the parity
  oracle (§3).
- **A `warn` severity tier.** Warnings are errors people have agreed to
  ignore.
- **`Result<T, E>` library / functional-core framework** (neverthrow, effect,
  fp-ts). Plain discriminated unions do the job without a dialect tax on
  every contributor; the composer already *is* a three-valued result type.
- **`useNamingConvention` lint rule.** The formatter + §7 prose + review is
  enough; the rule's false-positive rate on boundary field names
  (snake_case JSON keys, frozen `economics` keys) makes it net-negative here.
- **`isolatedDeclarations`.** Aimed at library declaration emit; quorum emits
  a binary, not `.d.ts` files. Pure friction, no payoff.

## 12. References

- `docs/superpowers/specs/2026-06-12-quorum-typescript-rewrite-design.md` —
  umbrella architecture; fixes runtime, layout, and validation strategy.
- `docs/superpowers/specs/2026-06-12-quorum-scheduler-design.md` — determinism
  and injectable-clock testing posture this standard generalizes.
- `~/Code/prime/brainstorm/{tsconfig.json,biome.json,lefthook.yml}` — the
  house baseline this standard starts from and tightens.
