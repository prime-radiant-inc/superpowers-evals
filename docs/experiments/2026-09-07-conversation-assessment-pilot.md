# Conversation and assessment appliance pilot

Status: authorized by Drew ("lgtm, let it rip"); preparing, no attempts launched.

## Question and fixed inputs

Does the new user/assessor split produce a natural coding-harness interaction,
independent grading grounded in retained output/transcript, and a usable standard
report? Can two copies per harness overlap without interference?

The implementation is Quorum d52b36be and Gauntlet
74d2037aed14f413db482b7635783e4e0498c316. This pilot adds only committed arm/suite
declarations and this experiment record. Superpowers main resolved to
b36e0829c6d0140e93cfef2ca599b1b07d4a7797; all six attempts use that exact revision and
high subject effort. The source snapshot records the final declaration commit.

| Role | Credential | Model |
|---|---|---|
| Claude subject | opus5_bedrock | anthropic.claude-opus-5 |
| Codex subject | openai_responses_56sol | gpt-5.6-sol |
| User and assessor | sonnet5_bedrock | anthropic.claude-sonnet-5 |

Use the existing committed September 6 pricing snapshot, SHA-256
6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b. These are estimated usage prices, not a
provider invoice. Retain unknown/missing cost coverage explicitly.

## Execution and stop conditions

1. Register suites/conversation_claude.yaml at cap 1, run once and inspect it.
2. If operationally valid and useful, register suites/conversation_codex.yaml at
   cap 1, run once and inspect it.
3. If both paths are useful and valid, register suites/conversation_parallel.yaml
   at cap 4: two fresh attempts per harness, four total.

Each attempt has a ten-minute conversation bound, two-minute assessment bound
and fifteen-minute outer deadline. Every suite uses reserve 0 and max_attempts 1.
There are six authorized attempts and no automatic retries/replacements.
A completed bad implementation or refusal remains a behavioral result.

Approved spend allocation is $40: $10 for the first two runs and $30 for the
four overlapping runs. Poll the installed helper's status/costs and cancel on
instrument failure, missing endpoint/evidence, wrong model routing, unusable
role behavior, lost started-role usage or allocation exhaustion. The allocation
is an operator stop rule, not a hard provider-billing ceiling.

Use an isolated installed copy of the existing appliance helper with the
canonical host-wide live-spend lock and existing blessed credential bundle.
Use the existing immutable runtime image and campaign source snapshots; leave
canonical source checkouts and the base container unchanged. No GitHub push,
new provider credential system, scheduler or campaign-policy change is required.

## Results

Pending preparation and registration. This file will record exact campaign and
attempt identities, timing/overlap, both-role cost coverage, behavioral findings
and any negative evidence. Do not infer model quality or throughput from the
earlier scripted offline tests.
