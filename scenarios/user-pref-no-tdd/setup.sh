#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo

# Inject the "no TDD" preference into the ambient instructions file THIS agent
# honors. Must suppress test-driven-development. Control = the existing
# triggering-test-driven-development scenario (no preference → TDD fires).
inject-user-preference "Do not use TDD (test-driven development) on this project. Write implementation code directly; do not write tests first or drive the work from tests."
