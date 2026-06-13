// check/record.ts — drop-in TS equivalent of quorum/bin/_record.
//
// Reads QUORUM_RECORD_SINK from the environment. When unset, all calls are
// no-ops so callers don't need to guard around it.
//
// Emitted JSON line shape (mirrors the shell _record_emit format):
//   {"check":<string>,"args":<string[]>,"negated":false,"passed":<bool>,"detail":<string|null>}

import { appendFileSync } from "node:fs";

interface RecordLine {
  check: string;
  args: string[];
  negated: boolean;
  passed: boolean;
  detail: string | null;
}

function emit(check: string, args: string[], passed: boolean, detail?: string): void {
  const sink = process.env["QUORUM_RECORD_SINK"];
  if (!sink) return;

  const line: RecordLine = {
    check,
    args,
    negated: false,
    passed,
    detail: detail !== undefined && detail !== "" ? detail : null,
  };
  appendFileSync(sink, JSON.stringify(line) + "\n");
}

export function recordPass(check: string, args: string[], detail?: string): void {
  emit(check, args, true, detail);
}

export function recordFail(check: string, args: string[], detail?: string): void {
  emit(check, args, false, detail);
}
