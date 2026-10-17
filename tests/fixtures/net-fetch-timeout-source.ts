import { setTimeout as delay } from "node:timers/promises";
import { fetchCapped } from "../../lib/net/fetch";

const modes = ["prefire", "before-headers", "after-headers"] as const;
const mode = process.argv[2] as typeof modes[number];

async function main() {
  if (!modes.includes(mode)) throw new Error("timeout_fixture_invalid_mode");
  if (typeof globalThis.gc !== "function") throw new Error("timeout_fixture_gc_unavailable");
  const originalAny = AbortSignal.any;
  const originalTimeout = AbortSignal.timeout;
  const caller = new AbortController();
  const watchdogReason = new Error("timeout_fixture_watchdog");
  let watchdogUsed = false;
  const onMessage = (message: unknown) => {
    if (message && typeof message === "object" && "kind" in message && message.kind === "abort") {
      watchdogUsed = true;
      caller.abort(watchdogReason);
    }
  };
  process.on("message", onMessage);
  let gcTimer: ReturnType<typeof setTimeout> | undefined;
  let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  let gcCount = 0;
  let gcStartMs: number | null = null;
  let gcEndMs: number | null = null;
  let gcFailure = false;
  let checkpointMs: number | null = null;
  let requestEnteredMs = 0;
  let headersReturnedMs: number | null = null;
  let consumedMs = 0;
  let observedReason: string | null = null;
  let observedWatchdogReason = false;
  let requestCount = 0;
  const pending = new Set<Promise<void>>();
  const started = performance.now();
  const at = () => performance.now() - started;
  const consume = async (signal: AbortSignal) => {
    checkpointTimer = setTimeout(() => { checkpointMs = at(); }, 110);
    gcTimer = setTimeout(() => {
      gcCount++;
      gcStartMs = at();
      try { globalThis.gc!(); } catch { gcFailure = true; }
      finally { gcEndMs = at(); }
    }, mode === "prefire" ? 0 : 150);
    // The source may fire and then be collected before Node's first lazy refresh.
    // No abort observer, signal getter, or source deref runs during this wait.
    await delay(250);
    consumedMs = at();
    try { signal.throwIfAborted(); }
    catch (error) {
      observedReason = error instanceof Error ? error.name : null;
      observedWatchdogReason = error === watchdogReason;
      throw error;
    }
  };
  try {
    process.send?.({ kind: "ready" });
    const result = await fetchCapped("https://8.8.8.8/timeout-source", {
      maxBytes: 8,
      timeoutMs: 100,
      signal: caller.signal,
      // Literal public IP avoids DNS; the existing injection avoids HTTP/SQL.
      request: async (_url, init) => {
        requestCount++;
        requestEnteredMs = at();
        if (mode !== "after-headers") {
          await consume(init.signal);
          return new Response("late", { status: 200 });
        }
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            const work = (async () => {
              try {
                await consume(init.signal);
                controller.enqueue(new Uint8Array([1]));
                controller.close();
              } catch (error) { controller.error(error); }
            })();
            pending.add(work);
            return work;
          },
        });
        headersReturnedMs = at();
        return new Response(body, { status: 200 });
      },
    });
    await Promise.allSettled(pending);
    const windowValid = gcCount === 1 && gcStartMs !== null && gcEndMs !== null
      && (mode === "prefire" ? gcEndMs < 100 : gcStartMs >= requestEnteredMs + 100 && gcEndMs < consumedMs);
    const message = {
      kind: "result", mode, runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
      requestCount, requestEnteredMs, headersReturnedMs, consumedMs,
      gcCount, gcStartMs, gcEndMs, gcFailure, checkpointMs, windowValid,
      observedReason, observedWatchdogReason, watchdogUsed, observerListenersAdded: 0,
      nativeMethodsUnchanged: AbortSignal.any === originalAny && AbortSignal.timeout === originalTimeout,
      result: result.ok ? { ok: true, status: result.status, bytes: result.body.length } : result,
    };
    await new Promise<void>((resolve, reject) => process.send!(message, error => error ? reject(error) : resolve()));
  } finally {
    clearTimeout(gcTimer);
    clearTimeout(checkpointTimer);
    await Promise.allSettled(pending);
    process.off("message", onMessage);
  }
}

void main().catch(async error => {
  await new Promise<void>(resolve => process.send?.({ kind: "fatal", name: error instanceof Error ? error.name : null }, () => resolve()));
  process.exitCode = 2;
}).finally(() => { process.disconnect?.(); });
