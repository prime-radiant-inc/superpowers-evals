---
id: triggering-finishing-a-development-branch
title: Agent loads finishing-a-development-branch skill when asked to wrap up completed work
status: ready
tags: skill-triggering
quorum_tier: sentinel
quorum_max_time: 20m
---

You are an engineer who has just finished a small change in this repo
and committed it. You believe the work is done and you want help
getting it wrapped up and integrated. You do NOT have a preference for
how to integrate it — you are asking the agent to take it from here.

When the agent is ready for input, type this exact message and press
Enter — do not paraphrase, do not shorten:

"I just finished the change I was working on and committed it. I think
this work is done. Can you help me wrap it up and get it integrated?"

How to behave for the rest of the run:

- If the agent presents you with a set of options for how to integrate
  the work (for example, merging, opening a pull request, keeping the
  branch, or discarding), pick the FIRST option offered and tell it to
  proceed. Do not invent your own integration plan.
- If the agent asks any other clarifying question, answer briefly and
  neutrally ("Whatever you think is best" / "main is the base, yes")
  without volunteering a workflow.
- Do NOT mention merging, pull requests, branches, cleanup, finishing,
  wrapping up workflows, or any superpowers concept beyond the exact
  message above.

Once the agent has loaded a skill OR has begun integrating the work
(running git, presenting integration options, or merging), you are
done — even if it picks an option you would not have. The agent
deciding what to do next is a complete run; whether it reached for the
right skill first is graded below.

## Acceptance Criteria

- The agent under test loaded the `superpowers:finishing-a-development-branch`
  skill before taking any integration action on the work. Evidence comes
  from Quorum's normalized `trajectory.json`: a native `Skill` invocation
  naming `superpowers:finishing-a-development-branch`, OR an equivalent
  shell read of the skill's `SKILL.md` (e.g. `cat`/`grep` of the skill
  file), OR a normalized `Read` of that `SKILL.md`. Any of these forms
  satisfies the criterion.

- The skill load came BEFORE any implementation-file `Edit` or `Write`.
  Reaching for the skill only after already editing project files defeats
  its purpose — the skill is meant to drive the wrap-up, not annotate it
  after the fact. Harness/private artifacts and `docs/superpowers` design
  specs do not count as implementation files.

- A run where the agent skips the skill and instead improvises an ad-hoc
  integration (e.g. immediately running `git merge`/`git push` or asking
  the human an open-ended "what do you want to do?" without loading the
  skill) is a COMPLETE run that FAILS this criterion. Do not treat the
  agent's narration ("I'll wrap this up for you") as evidence; only the
  skill load in the session log counts.
