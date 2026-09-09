/** Time remaining against the server's clock, independent of browser clock skew. */
export function remainingSeconds(deadlineAt: number, serverNow: number, elapsedMs = 0): number {
  return Math.max(0, Math.ceil((deadlineAt - serverNow - Math.max(0, elapsedMs)) / 1000));
}
