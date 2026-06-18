# Adding A Coding-Agent

Use this checklist to add a new quorum Coding-Agent target. Keep the shape
narrow: one target name, one YAML config, one launcher/HOWTO, one provisioning
adapter when needed, and one normalizer.

For running existing targets, use
[coding-agent-care-and-feeding.md](coding-agent-care-and-feeding.md).

## Before You Start

Confirm the CLI can run headlessly in a terminal and produce inspectable
session evidence. A desktop-only IDE integration cannot satisfy quorum.

Decide:

- Target name, e.g. `myagent`, used in `--coding-agent myagent`.
- Required credentials, and whether they use environment variables, OAuth files,
  or both.
- Where the CLI stores config and sessions when `HOME` is a throwaway directory.
- How Superpowers is installed or staged from `SUPERPOWERS_ROOT`.
- Which raw logs prove behavior and normalize into ATIF.

Do not add public-CI live runs. Live evals are trusted-maintainer operations.

## Step 0 — Install The CLI In The Eval Container

The eval container (`container/Dockerfile`, `ubuntu:26.04`) bundles every
agent CLI so quorum can launch the target headlessly. A new target's CLI must
be installed here before any live run. (A desktop-only IDE integration with no
headless CLI cannot be containerized and cannot be a quorum target.)

**Source the install recipe, don't guess one.** In priority order:

1. **Harbor** (`/tmp/harbor-inspect/src/harbor/agents/installed/<agent>.py`,
   pinned — see `docs/superpowers/reference/porting-harbor-converters.md`): its
   `install()` method is the authoritative, tested recipe for every agent Harbor
   supports. Read it for the package name, version, and any pre-reqs.
2. The vendor's official installer (npm package, PyPI package, `uv tool`, a
   `curl … | sh` installer, or a signed apt repo).

Verify the package/URL actually exists before editing (`npm view <pkg> version`,
`curl -fsSIL <url> | head -1`) — never commit an unverified install.

**Match the existing Dockerfile patterns:**

- npm-distributed CLI → add the package to the existing `npm install -g` block.
- Python CLI → `uv tool install <pkg>` (grouped with the other uv-tool installs),
  or, for a heavy one, a dedicated `uv venv` + a small wrapper script in
  `/usr/local/bin`.
- Single binary → download + `install -m 0755` (see goose).
- apt-distributed → add a signed keyring + repo, then `apt-get install`.

End every install block with a `--version`/`--help` check so a bad recipe fails
the build, and symlink the entrypoint into `/usr/local/bin` if the install dir
isn't already on `PATH`. Then update:

- `test/container-dockerfile.test.ts` — add the install-intent token(s).
- `container/bin/evals-tool-versions` — add the CLI's command name.

**Build and smoke it locally** (the build is the real gate; the static test only
checks the Dockerfile *mentions* the install):

```bash
orb start                       # ensure the OrbStack docker daemon is up
scripts/evals-container build    # multi-stage; resolves the gauntlet build-context
docker run --rm superpowers-evals:local bash -lc '<cmd> --version'
```

**Gotchas (each cost a failed build — watch for them):**

1. **Meta-package / restructured CLI.** A package can install but expose no
   console script or a moved entrypoint (openhands 1.x is a meta-package with no
   `openhands.core.main`). Pin a known-good version whose layout matches the
   normalizer, or skip the agent.
2. **Package-relative data dir.** A tool that resolves a `CONFIG_DIR` relative to
   its own package and asserts it exists breaks under a normal install (the data
   dir is left in the repo). Use an **editable** install (`uv pip install -e`) so
   the package resolves from the checkout (swe-agent).
3. **Installers that self-link as root.** A `curl | sh` installer run as root may
   already place its binary on `PATH` (FHS layout). Adding your own symlink then
   clobbers it with a dangling link (hermes — drop the manual `ln`).
4. **Auth-gated version check.** Some subcommands require login even for
   `--version`. Verify with the auth-free top-level command (`acli --version`,
   not `acli rovodev --version`); real auth is supplied at run time.
5. **Per-installer `$HOME` paths.** As root, an installer's `$HOME/.foo/bin` is
   `/root/.foo/bin` — symlink the binary from there (mimo), or rely on the
   installer's own PATH linking.

## Files To Add

1. Add `coding-agents/<name>.yaml`.

   Include the CLI command, required environment variables, concurrency limits,
   `home_config_subdir`, and the session-log directory pattern used by capture.

2. Add `coding-agents/<name>-context/HOWTO.md`.

   This is what the Gauntlet-Agent reads. It should explain how to launch the
   generated agent command, how to observe the session log, and when the run is
   complete. Keep it factual and target-specific.

3. Add `coding-agents/<name>-context/launch-agent` when the target needs a
   custom launcher.

   The launcher must run from the scenario workdir, use `$QUORUM_HOME_ENV` to
   pin `HOME`, XDG dirs, and `TMPDIR`, and avoid reading the operator's real
   home-relative state.

4. Add or update `src/agents/<name>.ts`.

   Use the provisioning adapter for target-specific config seeding, auth-file
   copying, preflight checks, plugin staging, and launcher substitutions. Route
   subprocesses through `src/agents/command-runner.ts` so tests can fake them.

5. Register the target in `src/agents/index.ts` and update the agent config
   schema if the target needs new fields.

6. Add `src/normalize/<name>.ts`.

   Convert the raw session evidence into ATIF `Trajectory` rows. Transcript
   checks read the normalized trace at `<run>/trajectory.json`.

7. Wire capture/economics behavior only where the shared path cannot cover the
   new target.

   Prefer the existing snapshot/diff capture path. Add target-specific export
   code only when the CLI stores sessions in a database or hidden state that
   must be materialized first.

8. Add a bootstrap scenario gated to the new agent.

   Use a `# coding-agents: <name>` directive in `checks.sh` and check
   provisioning and behavioral evidence when possible.

9. Update docs.

   Add the target to [coding-agent-care-and-feeding.md](coding-agent-care-and-feeding.md)
   and update README's agent list. If the target has unusual auth, capture, or
   safety behavior, document that in the care guide.

## Implementation Rules

- Keep each run's agent state under `<run>/home`; never symlink or read the
  operator's real `~/.<agent>` at runtime.
- Seed credentials into the run home before launch, with chmod `0600` for
  secret-bearing files.
- Use `SUPERPOWERS_ROOT` as the plugin/skill source. A globally installed plugin
  must not satisfy the eval accidentally.
- Fail closed when provisioning evidence or expected transcripts are missing.
- Treat empty normalized traces as capture failures for strict backends.
- Keep target-specific behavior in the target adapter and normalizer; do not put
  agent conditionals in scenarios.

## Verification

Run static checks first:

```bash
bun run check
bun run quorum check
```

Then run a live bootstrap smoke for the new target:

```bash
bun run quorum run scenarios/<name>-superpowers-bootstrap --coding-agent <name>
bun run quorum show <run-dir>
```

For a useful smoke, verify:

- The CLI launched under `<run>/home`, not the operator's real home.
- Superpowers was installed or staged from `SUPERPOWERS_ROOT`.
- Raw session evidence exists where the config says it should.
- `<run>/trajectory.json` contains the expected skill/tool rows.
- Secret-bearing files remain inside `results/` and are not committed.
