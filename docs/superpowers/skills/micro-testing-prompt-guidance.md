# Micro-testing prompt guidance

When you want to know whether a *wording change* in skill prose shifts agent
behavior, a full quorum run ($12-21, 45-80 min) is the wrong instrument —
its run-to-run variance (±20%+ on economics, larger on individual behaviors)
swamps wording-level effects. Micro-tests isolate the composition step:
one API call per sample, programmatic scoring, ~$0.15-0.50/sample, seconds
per iteration. Validated 2026-06-09/10 against the SDD dispatch-construction
guidance (results in `../../experiments/2026-06-10-sdd-cost-experiments.md`).

## Anatomy

1. **System prompt** = the guidance variant embedded in realistic
   surrounding skill context (the neighboring bullets, the section
   structure). Test the sentence where it will actually live — guidance
   interacts with its neighbors.
2. **User message** = a realistic mid-workflow scenario with everything the
   agent would actually have: prior state, file paths, constraints, an
   under-specified element if you are testing resistance to a temptation
   (under-specification is what elicits placeholders; clean specs elicit
   nothing).
3. **Output** = the composed artifact itself (a dispatch prompt, a plan, a
   report). Instruct "Output ONLY the X."
4. **Scoring** = greps for unambiguous markers, positive and negative.
   Choose markers that cannot be produced innocently (an exact magic
   string, a full signature), not concepts.
5. **Model** = the model that performs the role in production (the SDD
   controller runs on the session model — test on that).

## Rules learned the hard way

- **Always include a no-guidance control.** It is the only way to
  distinguish "the prohibition works" (control violates, prohibition
  doesn't) from "the prohibition backfires" (control scores *better* than
  the prohibition — observed: 3.6 vs 4.4 transcribed values) from "the
  scenario can't elicit the behavior" (everything scores 0 — observed for
  open-ended review directives; result is *inconclusive*, not a pass).
- **Manually inspect every flagged match before trusting a verdict.** Two
  observed false-positive classes: the agent quoting the rule it is
  following ("Do not re-run the test suite" matched a re-run grep), and
  naive negation detection mislabeling a real violation that followed an
  unrelated "don't" clause.
- **5 reps minimum, default temperature.** Variance between reps is itself
  signal: the winning dispatch-recipe phrasing scored identically 5/5;
  losing phrasings were noisy.
- **Iterate by re-deriving, not appending.** Adding a nuance clause to a
  measured winner regressed it (3.0 consistent → 3.8 noisy). If the winner
  has a gap, rewrite the recipe; never bolt on a caveat.
- **Escalate to a full run only for structural changes.** Wording-level
  effects proven here transfer; new mechanisms (scripts, file handoffs,
  background dispatch) still need one full-run confirmation because
  adoption depends on the full prompt stack.

## Skeleton

```python
import json, os, urllib.request
API = "https://api.anthropic.com/v1/messages"
def call(system, user, model="claude-opus-4-8", max_tokens=2000):
    body = {"model": model, "max_tokens": max_tokens,
            "system": system, "messages": [{"role": "user", "content": user}]}
    req = urllib.request.Request(API, json.dumps(body).encode(),
        {"x-api-key": os.environ["ANTHROPIC_API_KEY"],
         "anthropic-version": "2023-06-01", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        d = json.loads(r.read())
    return "".join(b.get("text","") for b in d["content"] if b.get("type")=="text")
# VARIANTS = {name: guidance_text}; cache each sample to a file so reruns
# only fill gaps; score with compiled regexes; print a per-rep table.
```

Worked examples from 2026-06-10 (full scripts preserved in the session's
scratch dirs, summarized in the experiments log): dispatch-composition
recipe vs prohibition; reviewer test-rerun directive; writing-plans
placeholder variants (three-variant design with a relocation arm, plus a
stage-2 seeded-defect detection test for guidance that doubles as a review
checklist).

## When a micro-test is the wrong tool

- The behavior only emerges across turns (escape-hatch appetite, model
  decay mid-session) — needs full runs, multiple of them.
- The change alters *what artifacts exist* (new scripts, files) rather than
  wording — adoption is the question, and adoption needs the full stack.
- You cannot name an unambiguous marker — if scoring needs an LLM judge,
  you are running a small eval, not a micro-test; budget accordingly and
  rotate labels.
