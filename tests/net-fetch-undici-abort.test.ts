import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { safeFetch } from "@/lib/net/fetch";

/**
 * 기본 경로(HTTP_ORIGIN_PERMITS 꺼짐)의 background origin 자리 — 목 없이 실제 undici 와 로컬 HTTP 서버로 본다.
 *
 * 실제 undici 는 기한(abort)에 본문 스트림을 먼저 오류로 만든다. 그래서 그 뒤의 reader.cancel 은 거절된다.
 * 취소 성공에만 자리를 놓으면 그 origin 의 자리가 영영 남아, 같은 origin 의 다음 background 요청이 모두
 * 자리 대기에서 자기 기한을 넘긴다(R4 재현). 프로세스 안의 자리라 외부 증거 없이 정산 뒤에 놓아야 한다.
 */
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
const open = new Set<ServerResponse>();
let requests: string[] = [];
let server: Server;
let base = "";

// 테스트마다 새 포트(= 새 origin)다 — 한 테스트가 남긴 자리가 다음 테스트의 결과를 바꾸지 않게
beforeEach(async () => {
  requests = [];
  vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url === "/slow") { res.writeHead(200, { "content-type": "text/html" }); res.write("<html>"); open.add(res); return; }
    res.end("done");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const res of open) res.destroy();
  open.clear();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

/** 첫 요청의 기한은 직접 끊고, 뒤따르는 요청은 실제 2초 기한을 받는다(회귀면 자리 대기에서 2초 뒤 null). */
function deadlines() {
  const first = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockImplementationOnce(() => first.signal).mockImplementationOnce(() => realTimeout(2_000));
  return first;
}
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 50));

it("a deadline abort while the caller reads the body frees the origin for the next background request", async () => {
  const first = deadlines();
  const fetched = await safeFetch(`${base}/slow`, "background");
  expect(fetched?.response.status).toBe(200);
  const reading = fetched!.response.text().then(() => null, (error: unknown) => error);
  // 본문이 흐르는 동안 같은 origin 의 다음 요청은 서버에 닿지 않는다(한 번에 하나는 그대로)
  const follower = safeFetch(`${base}/next`, "background");
  await turn();
  expect(requests).toEqual(["/slow"]);
  first.abort(new DOMException("held body deadline", "TimeoutError"));
  expect(await reading).toMatchObject({ name: "TimeoutError" });
  const next = await follower;
  expect(next?.response.status).toBe(200);
  expect(await next!.response.text()).toBe("done");
  expect(requests).toEqual(["/slow", "/next"]);
});

it("a deadline abort of an unread body frees the origin for the next background request", async () => {
  const first = deadlines();
  const fetched = await safeFetch(`${base}/slow`, "background");
  expect(fetched?.response.status).toBe(200);
  first.abort(new DOMException("unread body deadline", "TimeoutError"));
  await turn();
  const next = await safeFetch(`${base}/next`, "background");
  expect(next?.response.status).toBe(200);
  expect(await next!.response.text()).toBe("done");
  expect(requests).toEqual(["/slow", "/next"]);
});
