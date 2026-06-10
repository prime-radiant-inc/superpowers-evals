# Profiling a quorum run's economics

When a run is slower or more expensive than expected, profile **turns**, not
token prices: cost ≈ turns × resident context (cache re-reads dominate total
tokens, and wall-clock is roughly turns × API latency). All snippets run from
the evals root against a `results/<run>/` directory.

## Verdict + headline economics

```python
import json
v = json.load(open(f'results/{run}/verdict.json'))
ca = (v.get('economics') or {}).get('coding_agent') or {}
cost = ca.get('est_cost_usd') or sum(m.get('est_cost_usd', 0) for m in ca.get('models', []))
print(v['final'], v.get('final_reason'))
print('%.1f min' % (ca['duration_ms'] / 60000),
      sum(m['tokens']['total'] for m in ca['models']), 'tokens',
      '$%.2f' % cost)
```

`coding-agent-token-usage.json` adds per-model turn counts (`n_assistant_turns`)
— the first place to look. A cheap model with a huge turn count is costing you
wall-clock and cache reads, not saving money.

## Dispatch list (what the controller launched, with which models)

```python
for line in open(f'results/{run}/coding-agent-tool-calls.jsonl'):
    if '"Agent"' in line:
        a = json.loads(line).get('args') or {}
        print(a.get('model', '(default→session model!)'), '|', a.get('description', ''))
```

`(default)` means the subagent inherited the session's model — usually the most
expensive one. Also grep dispatch prompts for what the controller actually
passed (pasted diffs, constraints, suppression phrases like "do not flag").

## Per-subagent turn/tool profile (the money table)

Subagent transcripts live at
`results/<run>/coding-agent-config/projects/*/<session-id>/subagents/*.jsonl`.

```python
import json, glob, collections
roles = collections.Counter(); turns = collections.Counter()
for f in glob.glob(f'results/{run}/coding-agent-config/projects/*/*/subagents/*.jsonl'):
    t = 0; tools = 0; desc = ''
    for line in open(f):
        try: r = json.loads(line)
        except: continue
        if r.get('type') == 'assistant':
            t += 1
            tools += sum(1 for b in (r['message'].get('content') or [])
                         if isinstance(b, dict) and b.get('type') == 'tool_use')
        elif r.get('type') == 'user' and not desc:
            c = r['message'].get('content')
            desc = (c if isinstance(c, str) else
                    (c[0].get('text', '') if c and isinstance(c[0], dict) else ''))[:80].lower()
    kind = ('reviewer' if 'reviewing one task' in desc else
            'final' if 'senior code reviewer' in desc else
            'fix' if desc.startswith('you are fixing') or 're-review' in desc else
            'implementer')
    roles[kind] += 1; turns[kind] += t
for k in roles:
    print(f'{k:12} n={roles[k]:3} turns={turns[k]:4} avg={turns[k]/roles[k]:.1f}')
```

Reference points from the 2026-06-10 SDD optimization (go-fractals): reviewers
that re-derive diffs with git average ~9 turns / 6 tool calls; reviewers handed
a review-package file average ~3 turns / 1 tool call. Implementers ~15-30
turns; haiku subagents take 2-3× sonnet's turns for the same work.

## Asking a run's agent why it did something

The coding agent's session is resumable:

```bash
cd results/<run>/coding-agent-workdir
CLAUDE_CONFIG_DIR=$PWD/../coding-agent-config \
  claude --resume <session-id> -p "Retrospective question: why did you ...?"
```

(Session id = the jsonl filename under `coding-agent-config/projects/*/`.)
Agents answer retrospective questions candidly; this resolves "what were you
thinking" questions that transcripts can't.

## Comparing two runs' deliverables blind

Copy both `coding-agent-workdir`s to neutral paths (`/tmp/<x>/alpha`, `beta`),
delete build artifacts, rotate which config gets which label between
comparisons, and have a fresh judge (that knows nothing about the configs)
score both against the fixture's own plan.md. Trust verdicts that survive
label rotation; distrust single-sample margins — judge noise of ±1.5 points
is normal. Tell the judge: strictly read-only, no probe files even in copies.
