#!/usr/bin/env bash
set -euo pipefail
# Seeds the workdir from scenarios/<name>/fixtures/: a small order-checkout
# module plus a weak test whose sole assertion checks that a stand-in object
# exists (a tautology that tests nothing real). Runnable with `node --test`.
setup-helpers run init_repo_from_fixtures
