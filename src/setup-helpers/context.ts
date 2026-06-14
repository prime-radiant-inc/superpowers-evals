// src/setup-helpers/context.ts
import type { CommandRunner } from '../agents/command-runner.ts';

// The uniform argument every dispatchable helper receives. Replaces Python's
// signature-introspection: templateDir/superpowersRoot are filled by the CLI
// ONLY for helpers whose registry entry declares the need, and are undefined
// otherwise. `run` is the subprocess seam for Tier-2 helpers (uv/codex/gemini).
export interface HelperContext {
  readonly workdir: string;
  readonly templateDir: string | undefined;
  readonly superpowersRoot: string | undefined;
  readonly run: CommandRunner;
}

// A helper may be async (installCodexSuperpowersPluginHooks speaks JSON-RPC to
// the codex app-server); the CLI awaits every call.
export type Helper = (ctx: HelperContext) => void | Promise<void>;
