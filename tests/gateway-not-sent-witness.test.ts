import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { takeGatewayLocalEnd, takeGatewayNotSent } from "@/lib/llm/gateway-local-end";
import { gatewayFetch } from "@/lib/llm/gateway-local-end-fetch";

// 미전송 증인: 실제 소켓만 쓴다(undici·전송 모의 없음). 요청 바이트가 한 번도 안 나간 호출만 증명하고, 소켓에 쓰였을 수 있으면 절대 증명하지 않는다.
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const servers: Server[] = [];
const listen = async (handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> => {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
};
const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => { throw new Error("expected fetch to reject"); }, (error: unknown) => error);
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); }));
});

it("connection refused: nothing was written, so the call is proven not sent — once", async () => {
  const { server, port } = await listen(() => {});
  await new Promise<void>(resolve => server.close(() => resolve())); // 포트는 알지만 아무도 듣지 않는다.
  const error = await rejection(gatewayFetch(id(1), `http://127.0.0.1:${port}/v1/x`, { method: "POST", body: "{}" }));
  expect(takeGatewayNotSent(id(1), error)).toEqual({ requestId: id(1), dispatches: 1, code: "ECONNREFUSED" });
  expect(takeGatewayNotSent(id(1), error)).toBeNull();
});

it("DNS failure: no connection ever existed, so the call is proven not sent", async () => {
  const error = await rejection(gatewayFetch(id(2), "http://nonexistent.invalid/v1/x", { method: "POST", body: "{}" }));
  const proof = takeGatewayNotSent(id(2), error);
  expect(proof).toMatchObject({ requestId: id(2), dispatches: 1 });
  expect(["ENOTFOUND", "EAI_AGAIN"]).toContain(proof?.code);
  expect(takeGatewayNotSent(id(2), error)).toBeNull();
});

it("the proof carries only an error code — never a message or URL — and a code-less error still proves not-sent", async () => {
  const { server, port } = await listen(() => {});
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rejection(gatewayFetch(id(3), `http://127.0.0.1:${port}/v1/x?secret=1`, { method: "POST", body: "{}" }));
  const proof = takeGatewayNotSent(id(3), new Error("connect ECONNREFUSED 127.0.0.1 with a message that must not leak"));
  expect(proof).toEqual({ requestId: id(3), dispatches: 1, code: null });
  expect(Object.isFrozen(proof)).toBe(true);
  expect(takeGatewayNotSent(id(404), new Error("never tracked"))).toBeNull();
});

it("request was written, then the socket died: never proven not sent (onRequestStart fired); the local-end witness stays behind its flag", async () => {
  const { port } = await listen(request => { request.socket.destroy(); }); // 요청 헤더를 읽은 뒤 응답 없이 소켓을 끊는다.
  vi.stubEnv("MODEL_CAPACITY_LOCAL_END", undefined);
  const error = await rejection(gatewayFetch(id(4), `http://127.0.0.1:${port}/v1/x`, { method: "POST", body: "{}" }));
  await new Promise(resolve => setTimeout(resolve, 100)); // native 종료 callback 이 모두 온 뒤에도 미전송 증명은 없다.
  expect(takeGatewayNotSent(id(4), error)).toBeNull();
  expect(takeGatewayLocalEnd(id(4))).toBeNull(); // flag 없음 — 로컬 종료 증인은 노출하지 않는다.
  vi.stubEnv("MODEL_CAPACITY_LOCAL_END", "1");
  // 같은 사실이 flag 만 켜면 로컬 종료 증인이 된다(추적은 항상 켜져 있었다) — 위 null 은 started>0 때문이지 아직 안 끝나서가 아니다.
  expect(takeGatewayLocalEnd(id(4))).toEqual({ requestId: id(4), dispatches: 1, terminals: 1 });
});

it("success path: a 200 is never a not-sent proof; the local-end witness behaves as before (flag-gated, one-use)", async () => {
  const { port } = await listen((_request, response) => response.end("{}"));
  vi.stubEnv("MODEL_CAPACITY_LOCAL_END", undefined);
  const response = await gatewayFetch(id(5), `http://127.0.0.1:${port}/v1/x`, { method: "POST", body: "{}" });
  expect(await response.text()).toBe("{}");
  expect(takeGatewayNotSent(id(5), new Error("irrelevant"))).toBeNull();
  expect(takeGatewayLocalEnd(id(5))).toBeNull();
  vi.stubEnv("MODEL_CAPACITY_LOCAL_END", "1");
  expect((await (await gatewayFetch(id(6), `http://127.0.0.1:${port}/v1/x`, { method: "POST", body: "{}" })).text())).toBe("{}");
  expect(takeGatewayNotSent(id(6), new Error("irrelevant"))).toBeNull();
  expect(takeGatewayLocalEnd(id(6))).toEqual({ requestId: id(6), dispatches: 1, terminals: 1 });
  expect(takeGatewayLocalEnd(id(6))).toBeNull();
  vi.stubEnv("MODEL_CAPACITY_LOCAL_END", "yes"); // 잘못된 값은 증인을 만들지 않는다(예외 없이 null).
  expect(takeGatewayLocalEnd(id(5))).toBeNull();
});

it("a refused connection is also a local end when the flag is on, but taking one witness does not consume the other's proof", async () => {
  const { server, port } = await listen(() => {});
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.stubEnv("MODEL_CAPACITY_LOCAL_END", "1");
  const error = await rejection(gatewayFetch(id(7), `http://127.0.0.1:${port}/v1/x`, { method: "POST", body: "{}" }));
  expect(takeGatewayNotSent(id(7), error)).toMatchObject({ code: "ECONNREFUSED" });
  expect(takeGatewayLocalEnd(id(7))).toBeNull(); // 미전송 증명이 기록을 비웠다(한 번만).
});
