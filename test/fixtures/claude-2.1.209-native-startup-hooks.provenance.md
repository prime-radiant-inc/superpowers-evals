# Claude 2.1.209 startup-hook dialect reduction

This synthetic regression fixture preserves the field shapes and UUID-chain
relationships inspected in both Claude parent logs from the six-arm PR2258
diagnostic on 2026-09-06. It is a reduced dialect fixture, not a replayable native
capture or evidence that a comparison passed. No original messages, hook output,
commands, paths, timestamps, UUIDs, credentials, or provider response content are
included. All such values are synthetic.

Both originals begin with a `last-prompt` record without `lastPrompt`; then
`mode`, `permission-mode`, `hook_success` (`SessionStart:startup`, exit 0),
`hook_additional_context` (`SessionStart`), a file-history snapshot, and the first
external typed human input. That input's parent UUID points to the context hook,
whose parent points to the root success hook. After a tool result, both originals
contain `command_permissions` with an empty `allowedTools` array. The fixture
retains those exact metadata field shapes, reduces unrelated catalog/message
rows, and adds synthetic call/result and later typed-input links to exercise
continued authority without copying original content.

Original private parent-log SHA-256 values:

- Base: `6d17af59144f47fa5e7ffaa8a041c587970d3ac01e71d1ac4156e89f0d6b6cb8`
- Head: `cd7c39e25aa5b7d7f1b125fd609c848e50e69d391c7d90992312944bcd292ba6`

The original logs were inspected read-only. No historical output was repaired,
replayed, rescored, repriced, or used to establish a passing result. Source
regressions reproduced the missing-last-prompt and missing-root-human failures
before the parser change. The reduced fixture tests complete parent ancestry,
non-action metadata anchors, pending binding, rejected malformed metadata, and
continued rejection of broken links, SDK input, agent-origin input and children.
