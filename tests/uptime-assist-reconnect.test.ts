import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectUptimeAssist } from "@/lib/domain/products/uptime-delist-review";
import { safeFetch } from "@/lib/net/fetch";

const realTimeout = AbortSignal.timeout.bind(AbortSignal);
const candidate = { kind: "uptime" as const, product: { id: 1, slug: "sleeping-service", url: "",
  updatedAt: "2026-10-23 01:02:03.123456" }, health: { failures: 10, status: 0,
  checkedAt: "2026-10-23 02:02:03.123456", downSince: "2026-10-22 02:02:03.123456" } };
const open = new Set<ServerResponse>(), timers = new Set<ReturnType<typeof setTimeout>>();
let server: Server, base: string;

beforeEach(async () => {
  vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
  vi.stubEnv("HTTP_ORIGIN_PERMITS", "0");
  server = createServer((req, res) => {
    open.add(res);
    res.once("close", () => open.delete(res));
    if (req.url === "/fast") { res.end("ready"); return; }
    if (req.url === "/redirect") { res.writeHead(302, { location: "/warmup" }); res.end(); return; }
    if (req.url === "/stream") { res.writeHead(200); res.write("<h1>partial service text"); return; }
    const timer = setTimeout(() => { timers.delete(timer); res.end("<h1>Service is ready</h1><p>Create an account.</p>"); }, 150);
    timers.add(timer);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  for (const response of open) response.destroy();
  open.clear();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

it("실제 HTTP에서 일반 요청이 놓친 느린 응답을 비동기 확인으로 수집한다", async () => {
  // Production timeout arguments are asserted; only their wall-clock duration is scaled here.
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => realTimeout(ms === 60_000 ? 1500 : 50));
  expect(await safeFetch(`${base}/warmup`, "background")).toBeNull();
  const input = await collectUptimeAssist({ ...candidate, product: { ...candidate.product, url: `${base}/warmup` } });
  expect(input.sources[0]).toMatchObject({ completeness: "complete", httpStatus: 200, text: "Service is ready Create an account." });
  expect(timeout.mock.calls).toEqual([[10_000], [60_000]]);
});

it("실제 HTTP 리다이렉트와 느린 최종 응답이 전체 확인 기한 하나를 공유한다", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => realTimeout(ms === 60_000 ? 1500 : 50));
  const input = await collectUptimeAssist({ ...candidate, product: { ...candidate.product, url: `${base}/redirect` } });
  expect(input.sources[0]).toMatchObject({ url: `${base}/warmup`, completeness: "complete", httpStatus: 200 });
  expect(input.task === "uptime" && input.context.finalUrl).toBe(`${base}/warmup`);
  expect(timeout).toHaveBeenCalledExactlyOnceWith(60_000);
});

it("실제 HTTP의 끝나지 않는 본문은 긴 기한에도 제한되고 부분 근거를 성공으로 돌려주지 않는다", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(100));
  await expect(collectUptimeAssist({ ...candidate, product: { ...candidate.product, url: `${base}/stream` } }))
    .rejects.toMatchObject({ name: "TimeoutError" });
  expect(timeout).toHaveBeenCalledExactlyOnceWith(60_000);
  const following = await safeFetch(`${base}/fast`, "background");
  expect(await following?.response.text()).toBe("ready");
});
