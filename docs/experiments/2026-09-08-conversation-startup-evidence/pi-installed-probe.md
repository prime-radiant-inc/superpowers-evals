# Installed Pi offline probe

Date: 2026-09-08
Outcome: PASS

This probe exercised the actual generated interactive launcher and installed Pi
0.80.7 inside the appliance image with Docker networking disabled. One neutral
prompt reached a fixed loopback Responses fixture, produced one native Pi
session, and passed through Quorum's real ATIF capture, exposure, and Obol
pricing paths.

## Frozen inputs

- Quorum candidate: `325790fc06182260920d8f7eea20519fa91682a2`
- Candidate tree: `0c31faf0988de8703aee0fbf59e61cc3c3acbe8c`
- Appliance image:
  `sha256:01fb1cd08f1e31c82fccedbaadead09e6ff97bca1f5d66f2f0904728ad536e8c`
- Installed Pi: `0.80.7`
- Installed `dist/main.js` SHA-256:
  `29ac87b5944bb986cc356937aa9111178bb8732883e9f049676d01e90b107309`
- Installed `dist/core/session-manager.js` SHA-256:
  `879e80cc6e2371e4b06887e6fb041c323ba4e86f7687bfdac6474c9f61486112`
- Frozen pricing snapshot SHA-256:
  `6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b`
- Pricing snapshot date: `2026-09-06`

The operator observed that the candidate and local cherry-picked probe checkout
had the same Git tree, then staged the candidate in the probe-owned directory.
The operator also reported mounting the canonical checkout and dependency tree
read-only and adding only the dated probe. No separate source-tree or mount
provenance artifact was retained.

## Result

Pi's old encoded working-directory component would have been 345 bytes total,
90 bytes beyond the 255-byte component limit. The generated launcher had SHA-256
`2c2948915eb57b72cce8b19f8e564ef7bf9be73cc90b62d72211ff8287c91b06`.
It opened the interactive Pi 0.80.7 TUI at the deep working directory, accepted
`Please reply with a short greeting.`, and displayed
`Hello from the offline Pi probe.` The TUI showed `↑120 ↓25 R5`.
The screen capture is retained separately at
`results/conversation-startup-evidence/pi-installed-probe/final-bounded-screen.ansi`
with SHA-256
`6b180d85d1c57e304514d1e29bc89692247d822f3b94a4c0ff578132377fce01`.

Pi wrote session `01a08355-b1e7-7a4a-8468-fae469eb7ca4` only under the
explicit private session directory. The native user and assistant timestamps were
`2026-09-08T23:24:08.121Z` and `2026-09-08T23:24:08.190Z`.

The loopback provider accepted exactly one authenticated dummy request:
`POST /v1/responses`, model `gpt-5.6-sol`. The native usage was 120 fresh input,
zero cache-create, 5 cache-read, and 25 output tokens, 150 total. Quorum emitted
two ATIF steps, retained the native session ID on both, selected the user
timestamp as exposure, and omitted Pi's placeholder zero cost.

The frozen `litellm/gpt-5.6-sol` rates were $4 input, $0.40 cache read,
$5 cache write, and $20 output per million tokens. The independent calculation
was:

```text
(120 * 4 + 5 * 0.4 + 0 * 5 + 25 * 20) / 1,000,000 = $0.000982
```

The actual Quorum/Obol capture returned `$0.000982`, no unpriced models, and
`pricing_as_of: 2026-09-06`.

Container `4ae0504ad43609093ccbcbe40d3a7223c1d92d2da86e28171259dafd6ead7aca`
used network mode `none`, exited 0 after Ctrl-D ended the owned tmux session,
and made no paid request. The local fixture enforced one request and the probe
had a 120-second internal wait inside a 150-second outer deadline.

## Operator commands

The operator ran these ordinary commands through Tailscale SSH as
`quorum-runner@quorum-appliance`. `$host_root` was the unique
`/srv/quorum/pilots/conversation-pi-evidence-probe-325790fc` directory and
`$image` was the exact digest above.

```sh
ssh quorum-runner@quorum-appliance \
  'mkdir -p /srv/quorum/pilots/conversation-pi-evidence-probe-325790fc/source'
git archive 325790fc06182260920d8f7eea20519fa91682a2 | \
  ssh quorum-runner@quorum-appliance \
    'tar -C /srv/quorum/pilots/conversation-pi-evidence-probe-325790fc/source -xf -'
ssh quorum-runner@quorum-appliance \
  'mkdir -p /srv/quorum/pilots/conversation-pi-evidence-probe-325790fc/source/node_modules /srv/quorum/pilots/conversation-pi-evidence-probe-325790fc/source/docs/experiments/2026-09-08-conversation-startup-evidence'
rsync -a docs/experiments/2026-09-08-conversation-startup-evidence/pi-probe.ts \
  quorum-runner@quorum-appliance:"$host_root/source/docs/experiments/2026-09-08-conversation-startup-evidence/pi-probe.ts"

docker create --name conversation-pi-evidence-probe --network none \
  --mount type=bind,src="$host_root/source",dst=/workspace/probe-source,readonly \
  --mount type=bind,src=/srv/quorum/superpowers-evals/node_modules,dst=/workspace/probe-source/node_modules,readonly \
  --mount type=bind,src="$host_root/artifacts",dst=/probe \
  -e PROBE_IMAGE_ID="$image" \
  -e PROBE_QUORUM_SHA=325790fc06182260920d8f7eea20519fa91682a2 \
  -e OBOL_PRICING_DIR=/workspace/probe-source/docs/experiments/2026-09-06-pr2258-pricing \
  "$image" \
  /usr/bin/timeout --signal=TERM --kill-after=5s 150s \
  bun /workspace/probe-source/docs/experiments/2026-09-08-conversation-startup-evidence/pi-probe.ts
docker start conversation-pi-evidence-probe

launcher=$(jq -r .launcher "$host_root/artifacts/ready.json")
docker exec conversation-pi-evidence-probe \
  tmux -S /tmp/qpi.sock new-session -d -s probe -x 160 -y 50 "$launcher"
docker exec conversation-pi-evidence-probe \
  tmux -S /tmp/qpi.sock send-keys -t probe:0.0 -l \
  'Please reply with a short greeting.'
docker exec conversation-pi-evidence-probe \
  tmux -S /tmp/qpi.sock send-keys -t probe:0.0 Enter
docker exec conversation-pi-evidence-probe \
  tmux -S /tmp/qpi.sock capture-pane -ep -S - -t probe:0.0
docker exec conversation-pi-evidence-probe \
  tmux -S /tmp/qpi.sock send-keys -t probe:0.0 C-d
docker wait conversation-pi-evidence-probe
docker logs conversation-pi-evidence-probe
```

## Negative staging evidence

The first otherwise successful native run deliberately remained failed when the
pricing assertion disagreed. `OBOL_PRICING_DIR` was absent, so bundled Obol
0.9.0 used its 2026-08-05 table and returned `$0.0013525` for the same native
tokens. The frozen campaign snapshot is therefore load-bearing. The successful
run supplied its path before Bun imported Obol and asserted the snapshot path,
hash, date, full model row, and independent arithmetic before accepting the
captured value.

An intermediate run then passed the functional and frozen-pricing assertions
but invoked Bun directly while its receipt claimed a 150-second outer deadline.
That result is retained privately but is not the gate evidence. The final run
above used `/usr/bin/timeout --signal=TERM --kill-after=5s 150s`; its runtime
receipt records that exact executable and argument vector.

Raw native session, trajectory, usage, and runtime artifacts are retained under
the ignored local
`results/conversation-startup-evidence/pi-installed-probe/final-bounded-private/`
directory. This note excludes the private session and dummy credential files.
The probe did not read or project the appliance credential bundle.

After that copy, the retained cleanup receipt reported exactly:

```text
container_count=0
probe_directory=absent
run_lock_count=151
```

The lock count covered historical lock files under `/srv/quorum`; none are
attributed to this probe. The operator also observed that the earlier probe
directory was absent and the base image remained installed, but did not retain
those two checks in a separate artifact.
