# Conversation assessor reliability: retained offline tools

The user retired the bespoke diagnostic launcher on 2026-09-10. Current source
keeps the ordinary Quorum/Gauntlet lifecycle, capture and accounting improvements,
offline reconstruction/native-report analysis, semantic data and shared
qualification mechanics. Source integration is explicitly allowed before live
qualification. The candidate remains empirically **unqualified**; a merge grants
no deployment, credential access or provider execution authority.

## Existing ownership route

The operator route is the existing **`evals-appliance campaign`** interface:
`register`, `list`, `run`, `status`, `cancel`, `costs`, and `report`.
It owns the campaign's registration, bounded run, state, cancellation and readout.
Ordinary Quorum/Gauntlet worker execution sits beneath that owner:
`quorum run` → `runScenario` → `runPreparedConversation` →
`invokeGauntletRole` → `gauntlet assess`. This directory supplies no additional
operator or submission layer. `scenarios/conversation-design` remains the
existing scenario; no campaign registration or execution is performed here.

The normal assessment CLI currently starts a fresh rubric/evidence history. It
cannot resume the frozen historical seven-turn prefix. Its request journal supports
body capture and physical caps internally, but the ordinary assessment CLI does
not expose those options. These are documented capability gaps, not features
implemented here. A fresh scenario run would not be exact historical replay.
Scenario post checks run before assessment and cannot inspect its later response.
No call from checks.sh or alternate qualification operator fills those gaps.

## Offline reconstruction and analysis

[reconstruct.ts](reconstruct.ts) authenticates original executed and current
caller identities separately, expands authenticated spilled evidence, preserves
opaque native content and ordered tool/error history, and excludes later or
external judgments. Historical HTTP bytes were unavailable: the output is a
logical-prefix reconstruction, not a historical wire capture.

Its existing offline `prepareReconstruction` API (and `reconstruct.ts prepare`
entrypoint) creates only `reconstruction.json` and `reconstruction-review.json`
with exclusive writes. It compares original and caller pinned-adapter request
bytes without exclusions and compares those bytes with the fenced serializer in
[diagnostic.ts](diagnostic.ts). That serializer instantiates the pinned SDK only
inside an in-memory fetch boundary with synthetic authentication. It exposes no
client, transport override, live loop or CLI. Native-report classification is a
pure helper; embedded report-like reasoning is never salvaged into a valid report.
New reconstruction calls create no diagnostic proposal, allocation or authority.
Historical emitted proposals and all source/data hashes remain unchanged.

The previous dated parent/child execution, preparation, relocation, refusal and
authority modules have been removed from active source. Their source history,
private packages, unapproved proposals and negative logs remain historical
artifacts. They are not instructions to stage packages, provision an authority
index, request a dispatch exception or execute a diagnostic. No replacement
launcher or renamed wrapper was added.

## Preserved benchmark and qualification contracts

[benchmark-version.json](benchmark-version.json), [controls.ts](controls.ts),
[qualification-inputs.ts](qualification-inputs.ts),
[qualification-review.ts](qualification-review.ts), and the driver fixtures retain
their existing data and interfaces. [qualify.ts](qualify.ts) and the shared role
mechanics are preserved for their existing tests and reusable accounting behavior;
they are **inactive as an operator workflow**, not a replacement launcher.
The following is the historical benchmark definition, not a launch schedule:

| Binding group | Sessions | Atomic judgments | Repetitions |
| --- | ---: | ---: | --- |
| Retained historical corpus | 18 | 180 | Nine cases, twice each |
| Fixed supplemental controls | 8 | 16 | Eight controls, once each |
| Additional v2 controls | 2 | 4 | Two controls, once each |
| Revised assessment total | 28 | 200 | Declared group order |
| Controlled driver | 12 | Separate act review | Six situations, twice each |
| Fresh paired cohort | 36 attempts | Separate campaign readout | Existing suite |

The additional controls' original blind agreement remains **3/4**; accepted
**4/4** followed authored-gold exposure and scoped revision review. The loader
checks construction-time public source at `00f7a2d6` independently of current
caller identity. No frozen semantic receipt or benchmark identity was rewritten.
This control suitability evidence is not candidate accuracy or live authority.

Assessors receive only their own rubric and indexed evidence. Gold, expectations,
external judgments and other runs' reports remain outside their inputs. The
preserved readout distinguishes native validity, accepted semantic judgments,
operational coverage, corrections, known costs and unknown usage. Failed reports
and interrupted sessions remain in admission denominators; accepted agreement is
undefined with no accepted reports. Unknown invoice dollars are never treated as
zero. Known valid physical usage remains visible after operational failure.

The earlier dated `conversation-routine-use/run.ts` is an old campaign-helper
wrapper, not a second active runtime or advertised operator route. The old
nine-case qualification wrapper retains its 18/12 API schedules; the revised data defines
28/200 and additional driver review. Both existing wrappers consume current
Gauntlet completion/physical-accounting artifacts and cannot consume pre-Task-4
assessment output. Their retained review gates do not block this user-authorized
source merge and do not authorize execution.

## Verification and uncertainty

Offline tests cover reconstruction, pinned SDK byte equality, pure classification,
input authentication, qualification/accounting and native lifecycle behavior.
Private test roots are supplied explicitly. No provider outcome or reliability
improvement follows from local tests; [results.md](results.md) preserves the
historical observations and zero-live status.

The seven remaining dated TypeScript files are checked by real Biome lint on
isolated `src/` copies using the actual root rules, with only VCS discovery
disabled. Earlier stdin `check --write` evidence established formatting only.
The private verification record retains exact configs, source hashes, commands,
results and an invalid fixture proving that lint rejects non-null assertions and
explicit `any`. Ordinary source/tests use the repository's normal checks.

The paired lifecycle fixture explicitly settles deferred HTTP handlers after all
lifecycle assertions and before awaiting native server drain. A 13-second
watchdog and monotonic deadline guard preserve phase metadata/run artifacts for
slow or failed cleanup; a slow completed fixture fails so the outer test wrapper
cannot erase that evidence. The 15-second test bound, 200ms cooperative-kill grace
and production behavior are unchanged. This removes a demonstrated cleanup
dependency; historical timeout attribution remains unresolved.
