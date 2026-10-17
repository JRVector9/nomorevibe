import { fork } from "node:child_process";
import { expect, it } from "vitest";

type Mode = "prefire" | "before-headers" | "after-headers";
type Packet = {
  kind: string;
  requestCount: number;
  headersReturnedMs: number | null;
  consumedMs: number;
  windowValid: boolean;
  gcCount: number;
  gcFailure: boolean;
  watchdogUsed: boolean;
  observedWatchdogReason: boolean;
  observerListenersAdded: number;
  nativeMethodsUnchanged: boolean;
  observedReason: string | null;
  result: unknown;
};

function probe(mode: Mode) {
  return new Promise<{
    packet: Packet | null; fatal: boolean; processError: boolean; actualClose: boolean;
    childPid: number | undefined;
    exitCode: number | null; exitSignal: NodeJS.Signals | null;
    watchdogSent: boolean; termSent: boolean; killSent: boolean;
  }>(resolve => {
    const child = fork("tests/fixtures/net-fetch-timeout-source.ts", [mode], {
      execArgv: ["--import", "tsx", "--expose-gc"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, HTTP_ORIGIN_PERMITS: "0", ALLOW_PRIVATE_URLS: "0" },
    });
    let packet: Packet | null = null;
    let fatal = false, processError = false, watchdogSent = false, termSent = false, killSent = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    let kill: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      termSent = true;
      child.kill("SIGTERM");
      kill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) { killSent = true; child.kill("SIGKILL"); }
      }, 500);
    };
    const startup = setTimeout(terminate, 3000);
    child.stdout?.resume(); child.stderr?.resume();
    child.on("error", () => { processError = true; });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("kind" in message)) return;
      if (message.kind === "ready") {
        clearTimeout(startup);
        watchdog = setTimeout(() => {
          watchdogSent = true;
          if (child.connected) child.send({ kind: "abort" }, error => { if (error) processError = true; });
          drain = setTimeout(terminate, 1500);
        }, 1500);
      } else if (message.kind === "result" || message.kind === "fatal") {
        if (message.kind === "result") packet = message as Packet;
        else fatal = true;
        clearTimeout(watchdog);
        clearTimeout(drain);
        drain = setTimeout(terminate, 1000);
      }
    });
    child.once("close", (exitCode, exitSignal) => {
      for (const timer of [startup, watchdog, drain, kill]) clearTimeout(timer);
      resolve({ packet, fatal, processError, childPid: child.pid, actualClose: true, exitCode, exitSignal, watchdogSent, termSent, killSent });
    });
  });
}

for (const [mode, title] of [
  ["prefire", "retains the original timeout when GC runs before it fires"],
  ["before-headers", "retains the timeout source across GC before request completion"],
  ["after-headers", "retains the timeout source across GC after response headers"],
] as const) {
  it(title, async () => {
    // GC 시점이 계획한 창(prefire면 timeout 전) 안에 들어온 표본만 이 시나리오를 시험한다.
    // CI 부하로 창이 깨진 표본은 결론이 없으므로 다시 잰다. 판정 기준은 그대로이고, 다섯 번 모두 깨지면 실패한다.
    let result!: Awaited<ReturnType<typeof probe>>;
    for (let sample = 1; sample <= 5; sample++) {
      result = await probe(mode);
      console.info(JSON.stringify({ kind: "timeout_source_probe", mode, sample, ...result }));
      // The native process has closed before assertions can fail or cleanup starts.
      expect({ ...result, packet: undefined }).toEqual({
        packet: undefined, fatal: false, processError: false, actualClose: true,
        childPid: expect.any(Number),
        exitCode: 0, exitSignal: null, watchdogSent: false, termSent: false, killSent: false,
      });
      if (result.packet?.windowValid) break;
    }
    expect(result.packet).toMatchObject({
      kind: "result", requestCount: 1, windowValid: true, gcCount: 1, gcFailure: false,
      watchdogUsed: false, observedWatchdogReason: false, observerListenersAdded: 0, nativeMethodsUnchanged: true,
    });
    if (mode === "after-headers") {
      expect(result.packet!.headersReturnedMs).not.toBeNull();
      expect(result.packet!.headersReturnedMs!).toBeLessThan(result.packet!.consumedMs);
    }
    expect(result.packet!.result).toEqual({ ok: false, reason: "timeout" });
    expect(result.packet!.observedReason).toBe("TimeoutError");
  });
}
