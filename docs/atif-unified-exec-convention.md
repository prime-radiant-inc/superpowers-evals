# ATIF convention: unpacking codex `unified_exec` scripts

Codex's `unified_exec` feature routes all tool use through one custom tool
named `exec`. Its input is a JavaScript program that invokes
`tools.exec_command`, `tools.apply_patch`, `tools.update_plan`, and
`tools.write_stdin`. Codex enables the feature automatically for gpt-5.6-family
models and accepts `--enable unified_exec` for older ones. A rollout therefore
records one physical `custom_tool_call` per script, not one per action.

Two representations compete:

- **Verbatim** (upstream harbor ≤0.18): keep one call, `tool_name: "exec"`,
  `arguments: {input: <raw JS>}`. Faithful, but canonical-name consumers — all
  13 quorum transcript verbs, the skill and implementation detectors — go
  blind (PRI-2584).
- **Logical** (quorum): unpack the script into the canonical calls a
  pre-unified rollout would have produced.

Quorum emits the logical view and preserves the verbatim view in-band, using
the `extra` field ATIF reserves for exactly this.

## Producer rules

`src/normalize/codex.ts` (`normalizeExecScript`) implements them:

1. Split the script at each `tools.<verb>(`. The segment for the first verb
   starts at the script's first character, so preamble assignments
   (`const p = ".../SKILL.md"`) stay attached to the call that uses them.
2. Map each segment to a canonical call: `exec_command` → `Bash`,
   `apply_patch` → `Edit` (with `file_path`/`file_paths` extracted from the
   patch headers), `spawn_agent` → `Agent`, others verbatim.
3. Surface a `cmd` string literal as `arguments.command` only when it is
   static. A template literal with `${…}` interpolates variables defined
   elsewhere in the script, so the whole segment becomes the command instead.
4. A script with no recognized `tools.*` call becomes one `Bash` call whose
   command is the whole script.
5. All calls from one script share one ATIF step. The first call keeps the
   rollout `call_id`; later calls get `<call_id>#1`, `<call_id>#2`, …. The
   script's single output pairs to the first call.
6. Stamp every call with provenance:

   ```json
   "extra": {
     "composite_call_id": "<rollout call_id>",
     "script": "<verbatim JS segment this call was derived from>"
   }
   ```

## Consumer rules

- Treat any call carrying `extra.composite_call_id` as one action of a
  scripted composite. Group by that id to recover physical calls — never
  parse the `#n` id suffix.
- `extra.script` is the authoritative raw text for that call; use it when the
  extracted `arguments` are too narrow (audits, replay, byte counts).
- Parity against a verbatim-style converter: group quorum's calls by
  `composite_call_id`, then compare each group's `script` concatenation to the
  other side's single `exec` call.

Other Prime Radiant ATIF implementations (serf's Go exporter, obol's `atif`
dialect, harbor-eval-analysis-dashboard) should adopt these keys if they ever
produce or interpret unified_exec logs.
