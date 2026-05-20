#!/usr/bin/env bash
# If the agent reached for Edit or Write, Skill(systematic-debugging) must
# have fired earlier. In passing runs the QA agent stops the moment the
# skill loads, so usually no Edit/Write happens and both checks pass
# vacuously. The real failure mode this catches: agent starts patching
# code, *then* loads the skill to annotate the work after the fact.
set -euo pipefail
skill-before-tool superpowers:systematic-debugging Edit
skill-before-tool superpowers:systematic-debugging Write
