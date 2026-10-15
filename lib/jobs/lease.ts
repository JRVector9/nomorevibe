/** Six missed 15-second heartbeats expire ownership, across queue, runner and UI. */
export const STALE_LOCK_MS = 90_000;

export class JobLeaseLostError extends Error {
  constructor() { super("job_lease_lost"); }
}
