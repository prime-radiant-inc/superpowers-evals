# Claude configured-startup offline probe

Date: 2026-09-08
Status: configuration feasibility passed; live Mantle authentication remains a separate gate

## Boundary

The probe ran through Tailscale SSH on the configured Linux appliance. Every
case used Claude Code 2.1.209 from image
`sha256:01fb1cd08f1e31c82fccedbaadead09e6ff97bca1f5d66f2f0904728ad536e8c`,
Quorum `7aad7f0af36f58caae250484df6272822b42bdaf`, and Superpowers
`b36e0829c6d0140e93cfef2ca599b1b07d4a7797`. The source checkouts were mounted
read-only. Containers used the appliance runner's UID/GID, `--network none`, a
read-only root filesystem, an executable tmpfs, a 128-process limit, dummy
credentials and a 60-second outer timeout. No credential bundle or real
credential value was mounted or inherited.

[`claude-probe.py`](claude-probe.py) loads the current `opus5` or
`opus5_bedrock` row from the mounted `credentials.yaml`, invokes the real
`ClaudeAgent.provision`, and generates the launcher through
`buildContextSubstitutions` and `populateContextDir`. It adds only these private
home settings:

```json
{
  "hasCompletedOnboarding": true,
  "skipDangerousModePermissionPrompt": true
}
```

The onboarding value is written into both `.claude.json` paths. The settings
value is merged into `.claude/settings.json`. For the direct case only,
`settings.json.env.ANTHROPIC_BASE_URL` points to the loopback provider in the
same container. Claude 2.1.209 honored that private setting, so no launcher
derivation was needed.

Each case used the same bounded container recipe, with a fresh probe-prefixed
directory and container name:

```bash
docker run --rm --name "$probe_name" \
  --user "$(id -u):$(id -g)" --network none --read-only --pids-limit 128 \
  --mount "type=bind,src=$probe_dir,dst=/probe" \
  --mount type=bind,src=/srv/quorum/superpowers-evals,dst=/workspace/evals,readonly \
  --mount type=bind,src=/srv/quorum/superpowers,dst=/workspace/superpowers,readonly \
  --tmpfs /tmp:exec,nosuid,nodev --entrypoint python3 \
  sha256:01fb1cd08f1e31c82fccedbaadead09e6ff97bca1f5d66f2f0904728ad536e8c \
  /probe/claude-probe.py direct
```

The outer invocation was wrapped in `timeout --signal=TERM --kill-after=5s
60s`; the case argument was `direct`, `direct-delayed`, or `mantle`.

## Result

The positive composer signature observed in all three final cases is the
combination of:

1. a `Claude Code v2.1.209` header;
2. a standalone `❯` input line; and
3. the `bypass permissions on` footer.

No individual part was treated as sufficient. Theme, trust/security, bypass
acceptance, login and authentication screens remain failures. The earlier
guessed `? for shortcuts` marker did not appear and is not part of the result.

| Case | Ready observation | Input before ready | Provider requests | Retained result |
| --- | ---: | ---: | ---: | --- |
| Direct `opus5` | 0.656 s after tmux launch | 0 | 2 of 4 allowed | standalone `● PROBE_OK`; assistant-role native message with nonzero usage |
| Direct with fixed 2 s delay | 2.760 s from case start | 0 | 0 | Same composer signature; no request submitted |
| Dummy `opus5_bedrock` | 4.774 s from case start | 0 | 0 | Same composer signature; no request submitted |

The delayed and Mantle receipts started their elapsed clocks before provisioning,
so those two figures are conservative upper bounds rather than launch-only
latencies.

The direct launcher hash was
`220887e727fdc97595e86adf3d1216a59ad70854b6e25709a5d2274f748b7638`.
The current Mantle row bakes a different model and produced launcher hash
`f65b30ed811a27b049a639891232383f01d43250bc63be183c69f6fc8a02f285`.
Both launchers retained the Superpowers plugin argument. The direct env file
contained only `ANTHROPIC_API_KEY`. The Mantle env file contained exactly
`CLAUDE_CODE_USE_MANTLE`, `AWS_REGION`, and `AWS_BEARER_TOKEN_BEDROCK`, matching
the current `opus5_bedrock` row (`api: mantle`, `auth: bedrock-bearer`, model
`anthropic.claude-opus-5`, region `us-east-1`).

The neutral direct prompt did not contain the fixture answer marker. It produced
two bounded loopback calls: a streaming Haiku request and a streaming Opus 5
request, both to `/v1/messages?beta=true`. The provider returned Anthropic
messages with nonzero usage. Claude displayed standalone `● PROBE_OK` and wrote
one native JSONL session. Its assistant row contains exact text `PROBE_OK` and
nonzero usage in the same message. The retained post-exit JSONL hash is
`0d40101d649b2effb2778af6660e8d19a67d6fbde3db5e4330fff226d78814d1`.
The receipt's in-run snapshot hash is
`a77a20d06267e1e65d3ba40a18aab297f8117d202482d62e44bac33e79ebcb33`;
Claude appended rows during terminal cleanup before the final file was copied.
The final receipt hashes are:

- direct: `3772918dfe722a442cee05d29bd94ca0ae0142b95b18c2a723bd82af5ba6e9ed`;
- delayed: `afe24563e4623515a416acb9197086a07333f1ec3259b5df99ae48430277aad6`;
- Mantle readiness: `20f3f9e1820c2d234fda007f356e8a02778b2f0ec9d9a65963aa7adb366a4304`.

## Provisioning constraint for implementation

The direct API-key provisioner approves the key after its initial top-level
config mirror. The post-provision nested config had one approved fingerprint
while the top-level config had none. Its hashes were
`3b695531d6e04c54202fede46ac2314f99ce277451e0447f1d0b9666f8ed7e4a`
and `495d4993d515925e769e329b9db0927025d79135ffb94125333ff3289a1ca3e3`
respectively. Adding onboarding to those two divergent files left the approval
missing at the path Claude reads and produced the custom API-key menu without
making a provider request.

The passing configured home mirrors the fully provisioned nested config to
both paths, then adds onboarding. Both final config hashes are
`d14bc0e5389dbe0d9183adb859639dec8751c9f3208680951f8ba86c7d12ab28`.
Production implementation must preserve the final approval and trust state in
both paths; adding the onboarding flag alone is insufficient for the direct
API-key path.

The retained negative receipts also cover the expected root-user refusal, the
missing top-level key approval, and the obsolete guessed composer marker. The
earlier `final-direct-d1` receipt is invalid for response proof because its
response predicates matched the echoed user prompt. The two corrected no-request
receipts preserve the diagnosed input-submission failures. An early receipt
labeled Mantle used the wrong `auth: api-key` reconstruction; it is retained as
invalid evidence and excluded from every conclusion. The final Mantle receipt
loads `opus5_bedrock` directly from the registry.

After copying the private receipts, cleanup removed every probe-owned remote
directory. A final host audit found no `conversation-startup-probe` container
or process. `evals-appliance doctor --json` remained healthy with both locks
absent, and the canonical Quorum and Superpowers checkouts remained clean at
the SHAs above.

This establishes configured startup, one local direct response and native
session, and dummy Mantle readiness. It does not establish real Mantle
credential validity, provider availability, a live conversation, or grading.
