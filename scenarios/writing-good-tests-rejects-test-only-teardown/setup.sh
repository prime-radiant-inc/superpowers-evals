#!/usr/bin/env bash
set -euo pipefail
# Seeds the workdir from scenarios/<name>/fixtures/: a tiny instantiable Ledger
# (no lifecycle method) plus a test that shares one Ledger across cases and so
# leaks state. Runnable with `node --test`.
setup-helpers run init_repo_from_fixtures
