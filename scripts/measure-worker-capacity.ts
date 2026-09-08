/** Bounded GET-only local probe. Stop external collectors/use fixtures before measuring. */
import { basename } from 'node:path';

export type CapacityOptions = { origin: string; paths: string[]; rps: number; durationSeconds: number; maxInflight: number };
export function parseCapacityArgs(args: string[]): CapacityOptions {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(origin|paths|rps|duration-seconds|max-inflight)=(.+)$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error('Invalid or duplicate measurement argument');
    values.set(match[1], match[2]);
  }
  if (!values.has('origin')) throw new Error('--origin is required; use an isolated local deployment');
  const origin = new URL(values.get('origin')!);
  if (!['http:', 'https:'].includes(origin.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Only an explicit loopback HTTP(S) origin is supported');
  }
  const number = (key: string, fallback: number, maximum: number) => {
    const value = values.has(key) ? Number(values.get(key)) : fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${key}: 1..${maximum}`);
    return value;
  };
  const paths = (values.get('paths') ?? '/').split(',');
  if (paths.length > 10 || paths.some(path => {
    const url = new URL(path, origin);
    const pathname = new URL(decodeURIComponent(url.pathname), origin).pathname;
    return !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\r\n]/.test(path) ||
      url.origin !== origin.origin || /^\/(api|go)(\/|$)/.test(pathname);
  })) {
    throw new Error('Use 1..10 page paths on the same origin; API and tracked redirect routes are excluded');
  }
  return {
    origin: origin.origin, paths, rps: number('rps', 1, 20),
    durationSeconds: number('duration-seconds', 30, 120), maxInflight: number('max-inflight', 2, 10),
  };
}

export async function measureCapacity(options: CapacityOptions, request: typeof fetch = fetch) {
  const start = performance.now();
  const latencies: number[] = [];
  const statuses: Record<string, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, '429': 0, error: 0 };
  const pending = new Set<Promise<void>>();
  let started = 0, skipped = 0, peakInflight = 0;
  const period = 1_000 / options.rps;
  const count = options.durationSeconds * options.rps;
  for (let index = 0; index < count; index++) {
    const wait = start + index * period - performance.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    if (performance.now() - start >= options.durationSeconds * 1_000) { skipped += count - index; break; }
    if (pending.size >= options.maxInflight) { skipped++; continue; }
    // Missed slots are discarded; a slow event loop must not cause a catch-up burst.
    if (performance.now() - start > (index + 1) * period) { skipped++; continue; }
    const path = options.paths[started % options.paths.length];
    started++;
    const task = (async () => {
      const at = performance.now();
      try {
        const response = await request(new URL(path, options.origin), {
          method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5_000),
          headers: { 'user-agent': 'NoMoreVibe-local-capacity-check/1' },
        });
        const key = `${Math.floor(response.status / 100)}xx`;
        statuses[key] = (statuses[key] ?? 0) + 1;
        if (response.status === 429) statuses['429']++;
        await response.body?.cancel();
      } catch { statuses.error++; }
      finally { latencies.push(performance.now() - at); }
    })();
    pending.add(task);
    peakInflight = Math.max(peakInflight, pending.size);
    void task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
  const elapsedSeconds = (performance.now() - start) / 1_000;
  latencies.sort((a, b) => a - b);
  const percentile = (p: number) => latencies.length ? Math.round(latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] * 10) / 10 : null;
  return {
    origin: options.origin, paths: options.paths, requestedRps: options.rps,
    scheduledDurationSeconds: options.durationSeconds, elapsedSeconds: Math.round(elapsedSeconds * 100) / 100,
    started, completed: latencies.length, skipped, peakInflight,
    achievedRps: Math.round(latencies.length / Math.max(elapsedSeconds, options.durationSeconds) * 100) / 100,
    statuses, latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
  };
}
if (process.argv[1] && /^measure-worker-capacity\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void (async () => {
    const options = parseCapacityArgs(process.argv.slice(2));
    console.log(JSON.stringify(await measureCapacity(options), null, 2));
  })().catch(error => { console.error(error instanceof Error ? error.message : 'measurement failed'); process.exitCode = 1; });
}
