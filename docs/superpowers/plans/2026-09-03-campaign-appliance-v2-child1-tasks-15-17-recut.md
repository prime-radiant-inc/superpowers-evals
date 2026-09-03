# Campaign Appliance V2 Child 1 — Tasks 15–17 Re-cut Implementation Plan (v2, post adversarial review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the merged Child 1 per-attempt container worker (tasks 1–14, merged at `db1d7c16`) against real Docker on a real Linux host with zero model spend, then — separately approved — run one live paid attempt.

**Architecture:** A test-only `fake` runtime family gives the campaign path a subject that is a plain executable. A local `Bun.serve` stub speaks the Anthropic Messages API to Gauntlet's real grader over the Docker bridge gateway, so the full Quorum → Gauntlet → tmux → launcher path runs unmodified inside the real container image. All fixtures (fake agent YAML/context, scenario, credentials, suite) live in a **synthetic copy of the evals checkout** created and committed by the test at runtime — the production `coding-agents/`, `scenarios/`, and `suites/` trees are never touched. The suite is gated behind `QUORUM_DOCKER_INTEGRATION=1` and runs only on a Linux Docker host (the appliance). Task 3 (live proof) stays behind an explicit human approval gate.

**Tech Stack:** Bun (≥1.3) test runner, Bun.serve, Docker, the campaign dispatcher/container-spawner merged in Child 1.

**Revision history:** v1 (2026-09-03) failed adversarial review (Sol + Qwen, both NEEDS FIXES). v2 incorporates the reconciled fix set; every v1 defect and its resolution is listed in "Review Findings Resolved" below. The discipline rule from the retrospective stands: every external claim carries a citation checked against on-disk source; sections marked **HOST-VERIFY** are the facts that cannot be checked from this macOS machine and must be confirmed on the appliance before reliance.

## Global Constraints

- Every commit leaves `bun run check`, `bun run quorum check`, and `git diff --check` green; the Linux suite must skip cleanly (no fixture construction at module load) when `QUORUM_DOCKER_INTEGRATION` is unset.
- No new runtime dependencies. No `docker exec` on the campaign path. No quorum CLI flags added.
- Credential values must never appear in argv, Docker config/labels, job records, journal events, or log paths. Test assertions enforce this.
- Ordinary `quorum run`, `run-all`, dashboard matrices, and existing appliance jobs must not change behavior: no `coding-agents/fake.yaml` or fake scenario is ever committed to the production tree (run-all discovers every YAML — `src/run-all/matrix.ts:88,146,185,202`).
- Portable tests fake subprocesses and Docker; only `test/linux/` touches real Docker, and only under the env gate.
- Task 3 (live proof) spends real money and must not begin without Drew's explicit approval, separately from this plan's approval.

## Verified External Facts (grounding — checked 2026-09-03 against on-disk source, adversarially re-verified by two reviewers)

Citations: `gauntlet/` = `/Users/drewritter/prime-rad/gauntlet`; repo-relative otherwise.

**Protocol (grader ↔ fake provider):**

1. **Grader protocol is Anthropic Messages.** `client.messages.create` → `POST {baseURL}/v1/messages` (`gauntlet/src/models/anthropic.ts:141`; `gauntlet/node_modules/@anthropic-ai/sdk/resources/messages/messages.js:35`). The OpenAI backend uses the Responses API (`gauntlet/src/models/openai.ts:17`).
2. **Base URL override works via env.** SDK reads `ANTHROPIC_BASE_URL` when no explicit `baseURL` is passed; Gauntlet passes none (`gauntlet/src/models/anthropic.ts:101-117`; SDK `client.js:49,56`). Quorum's allowlist carries it (`src/runner/gauntlet-env.ts:95-102`); appliance-scoped projection maps `QUORUM_GRADER_ANTHROPIC_BASE_URL` → `ANTHROPIC_BASE_URL` (`src/credentials/grader.ts:16-21`; `gauntlet-env.ts:121-126`).
3. **Auth header in api-key mode is `x-api-key`, not `Authorization`** (SDK `client.js:119-135`; `gauntlet/src/models/anthropic.ts:94-108`). `anthropic-version: 2023-06-01` rides every request (SDK `client.js:477`). The provider records both headers.
4. **The SDK does no response-shape validation.** `convertResponse` (`gauntlet/src/models/anthropic.ts:256-303`) requires a `content` array and a `usage` object with numeric `input_tokens`/`output_tokens` (missing → NaN totals, `gauntlet/src/agent/agent.ts:486`). `stop_reason` optional (default `end_turn`); loop continuation is driven by `toolCalls.length > 0` (`agent.ts:688`). Requests carry `thinking:{type:"adaptive"}` and `output_config:{effort:"medium"}` — the fake must ignore unknown request fields.
5. **Grader tool surface (TUI adapter):** `type{text}`, `press{key}`, `type_and_submit{text}` (literal + Enter — the command-issuing tool), `read_screen{}`, shared `read{path}` (reads the run's context dir — under quorum's invocation that is `<runDir>/gauntlet-agent/context`, via `--project-dir <runDir> --state-dir gauntlet-agent`, `src/runner/index.ts:175-181`; `gauntlet/src/runs/orchestrator.ts:171`), `bash{command,timeout_ms≤60000}`, `watch_logs`, `wake_on_idle_log`, `report_result` last (`gauntlet/src/agent/agent.ts:285`; `gauntlet/src/adapters/tui/adapter.ts:314-361`; `gauntlet/src/agent/shared-tools.ts:46-63`). `read` is mounted only when the context root is populated (`gauntlet/src/agent/shared-tools.ts:34-48`; `gauntlet/src/context/read-tool.ts:46-48`).
6. **Run terminator.** `report_result{status: pass|fail|investigate, summary, observations[], criteria[]?, reasoning}` (`agent.ts:197-267`); other tool calls in the same turn are dropped; malformed reports get up to 2 text-tool_result retries (`agent.ts:585-622`). `result.json` (schemaVersion 5) at `<projectRoot>/<stateDir>/results/<runId>/result.json` (`gauntlet/src/runs/orchestrator.ts:218`; `gauntlet/src/types.ts:86-146`).
7. **Turn mechanics.** Turn 1 = system prompt (`## Story Card`, `## Acceptance Criteria`, adapter docs) + one user message starting `"Begin testing."` (`gauntlet/src/agent/prompts.ts:51-95`; `gauntlet/src/agent/initial-message.ts:10-18`). Tool results return batched as one user message of `tool_result` blocks (`anthropic.ts:170-204`). A request with tools == `[report_result]` is the budget-expiry grace turn (`agent.ts:901-992`) and must be answered with `report_result`. Text-only responses burn wall-clock budget (default 300 s, `gauntlet/src/config.ts:198`); six identical solo read-only turns force termination (`agent.ts:734-845`).
8. **Grader model id must be `claude`-shaped** — `resolveProvider` rejects other prefixes (`gauntlet/src/models/resolve.ts:31-37`), and the campaign report cross-checks observed `result.json` `config.model` against registered `grader.model` (`src/campaign/report.ts:617-626`). Use one id (e.g. `claude-fake-grader-0`) everywhere.

**Environment and isolation (the v1 failures, now grounded):**

9. **Containers cannot reach host loopback.** The spawner sets no `--network`/`--add-host` (grep `src/campaign/container-spawner.ts` — empty); containers run default bridge networking. The provider must bind `0.0.0.0` and the grader's base URL must use the Docker bridge gateway address resolved at test time (e.g. `docker network inspect bridge` → Gateway, typically `172.17.0.1` on Linux — **HOST-VERIFY** on the appliance). Do not add host-gateway support to the spawner: that is a production change for a test concern.
10. **The tmux pane inherits Gauntlet's full process env** (private server "inherits this process's full environment"; pane runs bare `bash -i` — `gauntlet/src/adapters/tui/adapter.ts:107-148`). Gauntlet's env is quorum's allowlist projection carrying grader material (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`; `src/runner/gauntlet-env.ts:69-140`) while subject variable names are allowlisted out. The container entrypoint sources both subject and grader delivery files into PID 1's env (`container/attempt-entrypoint.sh:50-62`). Therefore any launcher that simply `exec`s inherits the **grader's** credentials and **no** subject value — the fake launcher must scrub (`env -i`) and explicitly source a subject env file, mirroring the claude family.
11. **Credential delivery has a second closed, audited family registry.** `DELIVERY_BY_FAMILY` (`src/credentials/scope.ts:223-240`) keyed on `(family, auth)`; an absent pair throws (`scope.ts:290`); campaign dispatch calls it before Docker (`src/campaign/dispatcher.ts:3209`). The `fake` family needs an explicit `api-key` entry.
12. **Runtime projection reads the appliance bundle**, not credentials.yaml: `credentials.env` must carry the subject key name(s) plus `QUORUM_GRADER_ANTHROPIC_API_KEY` and `QUORUM_GRADER_ANTHROPIC_BASE_URL` (`src/appliance/credential-scope.ts:961-979, 1043-1064`); grader delivery throws without a nonempty auth alias. Subject and grader secret values must differ (`src/campaign/attempt-projection.ts:156`).
13. **`repoRoot()` pins the evals checkout to the running CLI's own source tree** (`src/cli/campaign.ts:873-877`; `src/paths.ts:12-16`); C12b forbids checkout flags (`test/campaign-cli-verbs.test.ts:762-778`); registration intake reads `arms/` from the running checkout and refuses fixtures outside it (`test/campaign-cli-verbs.test.ts:729-756`). Therefore the integration suite must copy the evals checkout, add fixture files, `git` commit in the copy, and run registration + campaign run as subprocesses **from the copy**.
14. **`campaignRun` is a top-level spender** and acquires the host-wide live-spend lock; the suite must point `QUORUM_LIVE_SPEND_LOCK` at a temp path (pattern: `test/campaign-cli-verbs.test.ts:62`) or it will contend with real appliance jobs.
15. **The bundle path reaches the spawner only via the appliance worker** (`src/appliance/campaign-run.ts:173,182`); the CLI `campaignRun` has no bundle option (`src/cli/campaign.ts:987-1001`). The suite must construct a real `ContainerAttemptSpawner` (bundleDir, image digest, uid/gid) and inject it via `campaignRun`'s `opts.spawner` seam (added in Child 1 for exactly this).
16. **`TMUX_TMPDIR` is intentionally identical across containers** (`/run/quorum/attempt`, `src/campaign/container-spawner.ts:31,371-373`); isolation comes from separate mount namespaces. The parallel-attempt assertion must assert identical textual values with **distinct backing mounts**, not distinct values.
17. **Fake-family seam (complete list, post-review):** `KNOWN_RUNTIME_FAMILIES` (`src/contracts/agent-config.ts:14-25`); superpowers capability registry entry `{ ref: false, none: true }` (`src/agents/index.ts:354-390`, enforced at `src/campaign/registration.ts:615-619`); the required-context family set (`src/runner/index.ts:1872`, currently `claude`/`serf`); the `DELIVERY_BY_FAMILY` entry (Fact 11); a subject-env-file provisioning hook + `$QUORUM_SUBJECT_FILE` context substitution mirroring the claude-only block at `src/runner/index.ts:1781-1787`. `DefaultAgent` otherwise does nothing (`src/agents/index.ts:101-110`); `binary` is gauntlet `--target` prompt text only (`src/runner/index.ts:1921`); harness matching is free-string (`src/credentials/scope.ts:284`). Context provisioning and the base substitution map (`$QUORUM_AGENT_CWD`, `$QUORUM_LAUNCH_AGENT`, `$QUORUM_AGENT_HOME`) are at `src/runner/context.ts:38-71,91-103` and `src/runner/index.ts:986-1018,1003`.
18. **Strict capture.** Normalizer `claude`; zero logs or zero tool-call rows → `indeterminate(stage=capture)` (`src/runner/index.ts:613-618,721-734`; `src/capture/index.ts:297-304`). The fake subject writes ≥1 valid claude JSONL assistant row with a `tool_use` block, a `timestamp`, and a `usage` object under `$QUORUM_AGENT_HOME/.claude/projects/**/*.jsonl`; usage charges once per `message.id` (`src/normalize/claude.ts:67-81,397-409`); unknown models price as `est_cost_usd: null` without failing (`src/obol/index.ts:176-182`). Claude logs are not cwd-filtered (`src/capture/cwd-filter.ts:7-8,157-163`).
19. **Registration mechanics:** estimates artifact `quorum.estimates/v1` (`src/contracts/estimates.ts:25-70`) keyed `(scenario, agent, credential, os)`, `generated_at` ≤30 days (`registration.ts:799-816`); one-arm exploratory suites supported (`src/contracts/campaign/suite.ts:50-64`); `budget_usd` positive (`suite.ts:83`); key-env preflight needs `api_key_env` names present and nonempty at registration for `auth: api-key` credentials (`registration.ts:766-797`) — dummy exports satisfy it. Registration requires `GAUNTLET_ROOT`/`SUPERPOWERS_ROOT` (C12b; `test/campaign-cli-verbs.test.ts:684-713`).
20. **Host execution.** The runbook defines `doctor`/`prepare`/job verbs only — no test-job concept (`docs/appliance-runbook.md:52-66,160-168`). The suite runs directly on the appliance host as `quorum-runner`: `QUORUM_DOCKER_INTEGRATION=1 bun test test/linux/` from a synced evals checkout with `GAUNTLET_ROOT`/`SUPERPOWERS_ROOT` set. **HOST-VERIFY:** `quorum-runner`'s docker socket access, checkout writability, and the installed wrapper's `evals.ref` branch check (`scripts/install-evals-appliance:22`) — the wrapper refuses a checkout whose branch differs from config, so the host procedure (Task 1 Step 7) must include an explicit sync/checkout step and be validated on the appliance first. Do not provision any new external host or service.

---

### Task 1: Protocol-correct zero-spend fixtures + Linux Docker integration suite

**Files (production seam — inert without fixtures):**
- Modify: `src/contracts/agent-config.ts:14-25` (add `fake` to `KNOWN_RUNTIME_FAMILIES`)
- Modify: `src/agents/index.ts:354-390` (registry: `fake` → `{ ref: false, none: true }`)
- Modify: `src/credentials/scope.ts:223-240` (`DELIVERY_BY_FAMILY`: `fake: { 'api-key': <projector> }` — api-key-only; other auth classes stay fail-closed)
- Modify: `src/runner/index.ts:1872` (add `fake` to the required-context set) and `:1781-1787` (add a `fake`-family block: provision `<runHome>/.fake-env` from the resolved subject env value and add `$QUORUM_SUBJECT_FILE`/`$QUORUM_SUBJECT_FILE_SH` to the substitution map)

**Files (portable tests):**
- Test: `test/agent-fake-family.test.ts` — family parse, `DefaultAgent` dispatch, registry entry, `DELIVERY_BY_FAMILY` projection shape, required-context gate, substitution + `.fake-env` provisioning, and the fake's canned JSONL row through the claude normalizer + `captureTokenUsage`. All synthetic configs in temp dirs; no committed `coding-agents/fake.yaml`.
- Test: `test/fake-provider.test.ts` — drives `test/linux/fixtures/fake-provider.ts` over HTTP using the **real `@anthropic-ai/sdk` client** (devDependency already present transitively via gauntlet's checkout; if not resolvable, use raw `fetch` but assert the exact request headers the SDK sends per Fact 3), including two concurrent conversations (Fact/I3 below) and a grace-turn request.

**Files (Linux-gated):**
- Create: `test/linux/campaign-attempt-docker.test.ts`
- Create: `test/linux/fixtures/fake-provider.ts`
- Create: `test/linux/fixtures/fake-coding-agent` (executable)
- Create: `test/linux/fixtures/synthetic-checkout.ts` (helper: copy repo → add fixtures → git init/commit → path)

**Interfaces:**
- Consumes: Child 1's merged machinery (`container-spawner.ts`, `attempt-projection.ts`, `attempt-publish.ts`, dispatcher container arm, `campaignRun` `opts.spawner` seam, Fact 15).
- Produces: the `QUORUM_DOCKER_INTEGRATION` gate convention; the synthetic-checkout harness Child 2's crash/reconciliation suite will reuse (per the skeleton spec's "over exactly those objects").

- [ ] **Step 1: Portable failing tests for the seam and provider** (`test/agent-fake-family.test.ts`, `test/fake-provider.test.ts`; run: `bun test test/agent-fake-family.test.ts test/fake-provider.test.ts` — expect failures).

- [ ] **Step 2: Production seam implementation.** The four modifications above, each mirroring its claude analogue and each covered by the Step 1 tests. The `fake` delivery projector delivers the credential as a single `NAME=value` stage file (same shape as the `apiKey` projector at `src/credentials/scope.ts`); the runner's `fake` block reads the resolved subject value from process env (entrypoint-sourced on the container path, Fact 10) into `<runHome>/.fake-env` mode 0600.

- [ ] **Step 3: Fake provider** (`test/linux/fixtures/fake-provider.ts`), runnable as `bun fake-provider.ts --bind <addr> --port <p> --record <file>`:
  - `Bun.serve` on the given bind address; only `POST /v1/messages` → 200; all else 404.
  - Per request, append NDJSON to `--record`: `{headers: {x_api_key, authorization, anthropic_version}, model, conversation_fingerprint, turn}`.
  - **Per-conversation state**, inferred from each request's message history (count of assistant turns / tool_result batches), never a server-global counter — two parallel attempts must not interleave (Fact from review I3; assertion 6 requires it).
  - Turn script: turn 1 → `tool_use` `read` `{path:"HOWTO.md"}`; turn 2 → extract the absolute path after `FAKE-SUBJECT-LAUNCHER:` from the tool_result text, `tool_use` `type_and_submit` `{text:<path>}`; turn 3 → `read_screen` `{}`; turn 4 → `report_result` `{status:"pass", summary, observations:[], reasoning}`. Tools == `["report_result"]` → immediate `report_result`. Unrecognized shape → `report_result` `status:"investigate"` (never bare text, Fact 7).
  - Response bodies per Fact 4: `{content:[{type:"tool_use", id:"toolu_<n>", name, input}], stop_reason:"tool_use", usage:{input_tokens:<n>, output_tokens:<m>}}`, real incrementing numbers.

- [ ] **Step 4: Fake subject + context fixtures** (created inside the synthetic checkout, never in the production tree):
  - `coding-agents/fake.yaml`: `name: fake`, `runtime_family: fake`, `binary: fake-coding-agent` (target text only, Fact 17), `session_log_dir: "${QUORUM_AGENT_HOME}/.claude/projects"`, `session_log_glob: "**/*.jsonl"`, `normalizer: claude`, `home_config_subdir: ".claude"`, `required_env: []`, `os_support: ["linux"]`.
  - `coding-agents/fake-context/launch-agent` (PROTOCOL-CRITICAL shape):
    ```sh
    #!/bin/sh
    exec env -i HOME="$HOME" PATH="$PATH" TERM="$TERM" \
      sh -c '. "$QUORUM_SUBJECT_FILE"; exec "$QUORUM_AGENT_CWD/fake-coding-agent" "$@"' -- "$@"
    ```
    (Scrub first, then source only the subject delivery — Fact 10. Exact allowlist finalized against the claude launcher's at implementation time.)
  - `coding-agents/fake-context/HOWTO.md`: instructs submitting the launcher path; embeds `FAKE-SUBJECT-LAUNCHER: $QUORUM_LAUNCH_AGENT`.
  - `test/linux/fixtures/fake-coding-agent`: `#!/bin/sh`; prints banner/prompt, canned reply per stdin line; on startup appends its sorted environment to `$QUORUM_ATTEMPT_DIR/subject-evidence/env.txt` (creating the directory), writes one timestamped claude JSONL assistant row with a `tool_use` block and `usage` (Fact 18) under `$QUORUM_AGENT_HOME/.claude/projects/fake/` (filename via `/proc/sys/kernel/random/uuid` with `uuidgen` fallback — **HOST-VERIFY** available tools in the image), and honors `FAKE_AGENT_DAEMONIZE=1` by forking a sleeper. Daemonize delivery: via the scenario's `setup.sh`-written fixture config, not Docker env (spawner deliberately excludes `spec.env`, `src/campaign/container-spawner.ts:401`).

- [ ] **Step 5: The integration suite** (`test/linux/campaign-attempt-docker.test.ts`). All fixture construction inside gated bodies (module level stays side-effect free):
  ```ts
  const enabled = process.env.QUORUM_DOCKER_INTEGRATION === '1';
  const it = enabled ? test : test.skip;
  ```
  Per test: build the synthetic checkout (Fact 13); start the provider bound to `0.0.0.0` with the record file in the test temp dir; author the bundle `credentials.env` with distinct dummy `FAKE_SUBJECT_KEY` and `QUORUM_GRADER_ANTHROPIC_API_KEY` plus `QUORUM_GRADER_ANTHROPIC_BASE_URL=http://<bridge-gateway>:<port>` (gateway resolved at runtime, Fact 9; Facts 12, 15); set `QUORUM_LIVE_SPEND_LOCK` to a temp path (Fact 14); write fixture `credentials.yaml`, `arms/fake.yaml`, one-arm exploratory suite (`grader.model: claude-fake-grader-0`, Fact 8; small positive `budget_usd`), fresh `quorum.estimates/v1` with one exact `(campaign_docker_fake, fake, fake_subject, linux)` row, and the `campaign_docker_fake` scenario (no-AC story; `setup.sh` installs `fake-coding-agent`; minimal `checks.sh` pre/post; generated `checks-manifest.json`; `checks.sh` non-executable) — all **inside the synthetic checkout**, committed there, registration invoked as a subprocess from the copy with dummy env exports (Fact 19), then `campaignRun` invoked with the real `ContainerAttemptSpawner` injected via `opts.spawner` (Fact 15).
  - Assertions (the original nine, corrected): PID-1/init/exit-status; daemonized survivor does not hold the container; `docker stop` → stopped verdict + `exit.json` + agent gone; SIGKILL leaves mode-0600 logs; mount audit (no bundle/journal/sibling/docker-socket); two parallel attempts — identical textual `TMUX_TMPDIR`, distinct backing mounts (Fact 16); isolation — subject env evidence contains only the subject value and never the grader value; provider records show the grader value only in `x_api_key` and the subject value in no header; no credential value in `docker inspect`/journal/job record/logs; full run commits manifest → published `verdict.json` + journal `run_allocated` (container arm) + terminal event.
  - **Teardown (mandatory):** `finally`/afterAll removes every captured container by exact ID (`docker rm -f`), stops the provider, removes temp trees, and releases the lock. Successful and stopped containers are retained by design (`src/campaign/container-spawner.ts:301,506`) — the suite owns cleanup.

- [ ] **Step 6: Host execution (HOST-VERIFY first).** On the appliance as `quorum-runner`: confirm docker socket access and checkout writability (Fact 20); sync the evals checkout to the pushed SHA (respecting the wrapper's `evals.ref` branch check — use a detached/aligned ref per the installer's rule); `scripts/evals-container build`; `GAUNTLET_ROOT=/srv/quorum/gauntlet SUPERPOWERS_ROOT=/srv/quorum/superpowers QUORUM_DOCKER_INTEGRATION=1 bun test test/linux/`. Iterate only the fake-agent ↔ gauntlet interaction there. Never run ungated on macOS.

- [ ] **Step 7: Portable gate stays green** with the suite skipped: `bun run check && bun run quorum check && git diff --check`. Commit.

### Task 2: Runbook section

**Files:** Modify `docs/appliance-runbook.md`

- [ ] **Step 1:** Add the `campaign run` section: host-side registration prerequisites (`GAUNTLET_ROOT`, `SUPERPOWERS_ROOT`, sourcing the blessed bundle's `credentials.env` for key-presence, registering as `quorum-runner`); the validated host procedure for the zero-spend integration suite (Task 1 Step 6, as actually performed); the verb's job-record semantics ("exit zero means recorded, not completed"); follow-up via `status` / `docker ps --filter label=quorum.campaign_id=<id>`; the cancellation model; the `live_spend_lock` config field with production value `/var/lib/quorum/live-spend.lock.d`; the non-coverage list pointing to children 2–4. Document only behavior observed in Task 1.
- [ ] **Step 2:** Gate green, commit.

### Task 3: Live one-attempt proof (APPROVAL-GATED)

**Do not start without Drew's explicit go-ahead. This task spends real money (one attempt) on the production appliance.**

- [ ] **Step 1:** Preflight on the appliance as `quorum-runner`: doctor green; image built; Task 1's suite green on that host.
- [ ] **Step 2:** Host-side registration of a one-cell, one-sample exploratory suite with a real credential.
- [ ] **Step 3:** `evals-appliance campaign run <campaign-id> --json`; observe exactly one `quorum-attempt-*` container carrying the three identity labels.
- [ ] **Step 4:** Verify durable evidence: `verdict.json` + `manifest.json` exist and are consistent. The verdict's pass/fail is irrelevant — a real verdict from a real model is the proof.
- [ ] **Step 5:** Seal via `quorum campaign report`.
- [ ] **Step 6:** Write the dated `docs/experiments/` entry: image digest, SHAs, campaign/attempt IDs, timing, every observed behavior Child 3 must honor, negative observations at equal billing.

## Review Findings Resolved (v1 → v2)

| Finding | Severity | Resolution |
|---|---|---|
| Provider unreachable from container (both reviewers C1) | Critical | Fact 9; gateway-addressed base URL, `0.0.0.0` bind, no spawner change |
| Fixture root invisible to `repoRoot()`-pinned registration (both, C2) | Critical | Fact 13; synthetic committed checkout, subprocess CLI from the copy |
| Launcher inherits grader env, no subject value (both, C3) | Critical | Facts 10/17; scrubbing launcher + `$QUORUM_SUBJECT_FILE` provisioning seam |
| `DELIVERY_BY_FAMILY` closed registry missed (Sol #2) | Critical | Fact 11; audited `fake` api-key projector entry |
| `fake.yaml` in production tree changes run-all/dashboard (Sol #7) | Critical | Global constraint; fixtures exist only in the synthetic checkout |
| Bundle fixture + spawner construction unstated (Qwen I1) | Important | Facts 12/15; Step 5 authors bundle, injects real spawner |
| Live-spend lock collision (Qwen I2) | Important | Fact 14; temp `QUORUM_LIVE_SPEND_LOCK` |
| Global turn counter breaks parallel attempts (both) | Important | Step 3: per-conversation state from message history |
| No teardown (both) | Important | Step 5 teardown block |
| TMUX_TMPDIR assertion wrong (Sol #6b) | Important | Fact 16; assertion corrected |
| `FAKE_AGENT_DAEMONIZE` had no delivery path; uuidgen unverified (Sol) | Important | Step 4: setup.sh-written config; `/proc` uuid with fallback |
| Raw `fetch` test misses SDK request shape (Sol) | Important | Step 1: real SDK client preferred, header assertion fallback |
| Fact citations unclean (path prefixes, runbook overreach, line drift, JSONL timestamp, gated construction, checks.sh bit) | Minor | Facts renumbered/rewritten; M1–M6 folded into steps |

## Self-Review Notes

- Spec coverage: "Linux-only Docker integration suite with fake subject, grader, and provider executables" (skeleton spec:103-104, 513-519, 533-534) → Task 1; runbook → Task 2; live proof → Task 3. The spec's "Linux devbox during development" is corrected to the appliance host (Fact 20).
- Every claim about gauntlet, Docker networking, credential flow, registration, and the runner carries a citation re-verified by two independent reviewers; the two remaining unverifiable-from-macOS items are marked **HOST-VERIFY** with an explicit verification step before reliance.
- Consistency: `fake`, `fake_subject`, `fake_grader` (bundle names), `campaign_docker_fake`, `claude-fake-grader-0`, `FAKE-SUBJECT-LAUNCHER:`, `$QUORUM_SUBJECT_FILE` are used identically across tasks.
