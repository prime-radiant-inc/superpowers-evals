/** Exhaustiveness guard for closed unions (coding standard §5.1). The compiler
 *  only allows the call when every case is handled; the throw is a runtime
 *  backstop for data that violated its type at a boundary. */
export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
