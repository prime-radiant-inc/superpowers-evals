#!/usr/bin/env bash
set -euo pipefail
# Seeds the workdir from scenarios/<name>/fixtures/: a ToolCatalog whose
# duplicate-detection depends on a real on-disk config write, plus a SLOW
# manifest client and a test that goes through it (slow but green). Runnable
# with `node --test`.
setup-helpers run init_repo_from_fixtures
