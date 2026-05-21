#!/usr/bin/env bash
# The native hook should bootstrap Superpowers so the naive request
# triggers brainstorming.
set -euo pipefail
exec skill-called superpowers:brainstorming
