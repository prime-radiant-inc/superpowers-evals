# Gauntlet observer termination proposal: retired

Date: September 5, 2026. Tracking: PRI-3097.
Status: retired before implementation; Drew selected the simpler container-based
acceptance boundary in the [approved comparison design](2026-09-05-pr2258-parallel-comparison-design.md#capture-finalization-and-replay).

The previous proposal added a Linux child-subreaper, a Python helper and a
private termination-receipt protocol around Gauntlet. No source implementation,
installation or Linux qualification of that proposal occurred.

The accepted approach keeps candidate capture and scoring in the worker. After
the existing campaign controller verifies the exact container has stopped, the
publisher compares bound raw sources and terminal artifacts with the candidate.
Only matching final state can publish; changed or missing evidence is unusable.
The publisher neither repairs candidates nor reruns scoring.

This removes in-worker process-termination proof as a dependency of PR2258.
Existing Gauntlet cleanup limitations remain documented in Git history; they do
not justify a second lifecycle mechanism for this comparison. The existing
five-second hard-kill grace and separate Linux/installed/spending gates remain.
