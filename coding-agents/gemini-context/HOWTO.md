# Gemini CLI Coding-Agent

Launch Gemini by running:

```bash
$QUORUM_LAUNCH_AGENT
```

The launcher already changes into the prepared workdir and pins a throwaway
`$HOME` for the run (so Gemini finds its seeded config under `$HOME/.gemini`,
not the user's real one). Do not run `gemini` directly, and do not use the
user's `~/.gemini` directory.

After Gemini is ready, send the scenario request exactly as written in
`story.md`. When the scenario objective is complete, end the Gemini session.
