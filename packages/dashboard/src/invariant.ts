// Local exhaustiveness guard for the dashboard's closed unions. The compiler
// only allows the call when every case is handled; the throw is a runtime
// backstop for data that violated its type at a boundary. Kept local so the
// dashboard imports nothing from the harness.
export function assertNever(value: never): never {
  throw new Error(`unexpected value: ${String(value)}`);
}
