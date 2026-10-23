import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalModelRelay, type LocalModelRelayOptions } from "@/scripts/local-model-relay/service";
import { fileRelayReceiptStore } from "@/scripts/local-model-relay/store";
import { LOCAL_MODEL_RELAY_REQUEST_HEADER, type RelayReceipt } from "@/scripts/local-model-relay/protocol";
import { isTailnetIpv4, localModelRelayConfig } from "@/scripts/local-model-relay/config";

const TOKEN = "relay-private-token-" + "a".repeat(40);
const UPSTREAM_TOKEN = "upstream-private-key-" + "b".repeat(40);
const MODEL = "qwen3.8-flash-next";
const servers: http.Server[] = [], directories: string[] = [];
const body = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "본문 확인" }], stream: true });
const finish = `data: ${JSON.stringify({ model: MODEL, choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\ndata: [DONE]\n\n`;

const gate = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>(yes => { resolve = yes; }), release: () => resolve() };
};
const listen = async (server: http.Server) => {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};
const waitUntil = async (check: () => boolean | Promise<boolean>) => {
  for (let index = 0; index < 100; index++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("condition_not_reached");
};

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function start(handler: http.RequestListener, over: Partial<LocalModelRelayOptions> = {}, directory?: string) {
  const upstreamPort = await listen(http.createServer(handler));
  const state = directory ?? mkdtempSync(path.join(os.tmpdir(), "nmv-local-relay-"));
  if (!directory) directories.push(state);
  const service = createLocalModelRelay({ token: TOKEN, upstreamToken: UPSTREAM_TOKEN, allowFrom: ["127.0.0.1"], model: MODEL,
    relayRevision: "c".repeat(40), deploymentRevision: "d".repeat(40), store: fileRelayReceiptStore(state), upstreamPort, ...over });
  const port = await listen(service), base = `http://127.0.0.1:${port}`;
  const call = (url: string, init: RequestInit = {}, token: string | null = TOKEN) => fetch(base + url, { ...init,
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...init.headers } });
  const chat = (text = body, id = randomUUID()) => call("/v1/chat/completions", { method: "POST", headers: {
    "content-type": "application/json", [LOCAL_MODEL_RELAY_REQUEST_HEADER]: id }, body: text });
  const receipt = async (id: string) => (await (await call(`/v1/requests/${id}`)).json()) as RelayReceipt;
  return { service, port, base, state, call, chat, receipt };
}

describe("M1 사설 모델 relay", () => {
  it("생산 설정은 CGNAT 사설 주소·개별 허용 IP·분리된 private 파일만 받는다", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "nmv-local-relay-config-")); directories.push(directory);
    const relayKey = path.join(directory, "relay"), upstreamKey = path.join(directory, "upstream");
    writeFileSync(relayKey, TOKEN, { mode: 0o600 }); writeFileSync(upstreamKey, UPSTREAM_TOKEN, { mode: 0o600 });
    const env = { LOCAL_MODEL_RELAY_HOST: "100.80.1.2", LOCAL_MODEL_RELAY_ALLOW_FROM: "100.90.1.2,100.91.1.2",
      LOCAL_MODEL_RELAY_TOKEN_FILE: relayKey, LOCAL_MODEL_RELAY_UPSTREAM_TOKEN_FILE: upstreamKey,
      LOCAL_MODEL_RELAY_STATE_DIR: directory, LOCAL_MODEL_RELAY_VERSION: "c".repeat(40) };
    expect(localModelRelayConfig(env)).toMatchObject({ host: "100.80.1.2", port: 8792, model: MODEL, deploymentRevision: "unverified" });
    for (const host of ["0.0.0.0", "::", "127.0.0.1", "100.63.1.2", "100.128.1.2", "1.2.3.4"]) {
      expect(isTailnetIpv4(host)).toBe(false);
      expect(() => localModelRelayConfig({ ...env, LOCAL_MODEL_RELAY_HOST: host })).toThrow();
    }
    expect(() => localModelRelayConfig({ ...env, LOCAL_MODEL_RELAY_ALLOW_FROM: "" })).toThrow();
    expect(() => localModelRelayConfig({ ...env, LOCAL_MODEL_RELAY_UPSTREAM_URL: "http://evil" })).toThrow();
    expect(() => localModelRelayConfig({ ...env, LOCAL_MODEL_RELAY_UPSTREAM_TOKEN_FILE: relayKey })).toThrow();
    expect(() => localModelRelayConfig({ ...env, LOCAL_MODEL_RELAY_MODEL: "unloaded-model" })).toThrow();
    chmodSync(upstreamKey, 0o644); expect(() => localModelRelayConfig(env)).toThrow("relay_token_file_permissions");
  });

  it("인증·실제 소켓 출처·고정 route·JSON 크기를 검사하고 임의 upstream을 받지 않는다", async () => {
    let calls = 0;
    const upstream: http.RequestListener = (_req, res) => { calls++; res.end("{}"); };
    const relay = await start(upstream, { maxBodyBytes: 256 });
    expect((await relay.call("/v1/health", {}, null)).status).toBe(401);
    expect((await relay.call("/v1/health", {}, "wrong")).status).toBe(401);
    for (const url of ["/admin", "/v1/chat/completions?upstream=http://evil", "/v1/models?key=secret", "/v1/requests/../../secret"]) {
      const response = await relay.call(url);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("secret");
    }
    expect((await relay.chat(JSON.stringify({ model: MODEL, messages: [], base_url: "http://evil" }))).status).toBe(400);
    expect((await relay.chat(JSON.stringify({ model: "other", messages: [{}] }))).status).toBe(400);
    expect((await relay.chat(JSON.stringify({ model: MODEL, messages: [{}], n: 2 }))).status).toBe(400);
    expect((await relay.chat("{")).status).toBe(400);
    expect((await relay.chat(JSON.stringify({ model: MODEL, messages: [{ content: "x".repeat(300) }] }))).status).toBe(413);
    const blocked = await start(upstream, { allowFrom: ["100.80.0.1"] });
    expect((await blocked.call("/v1/health", { headers: { "x-forwarded-for": "100.80.0.1" } })).status).toBe(403);
    expect(calls).toBe(0);
  });

  it("SSE·finish_reason·usage와 요청 본문은 원문 보존하고 두 비밀키를 분리한다", async () => {
    const received: { authorization?: string; forwarded?: string; body?: string } = {};
    const wire = 'data: {"model":"qwen3.8-flash-next","choices":[{"delta":{"content":"안녕"},"finish_reason":null}]}\n\n' + finish;
    const relay = await start(async (req, res) => {
      received.authorization = req.headers.authorization;
      received.forwarded = req.headers["x-forwarded-for"] as string | undefined;
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      received.body = Buffer.concat(chunks).toString();
      res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": UPSTREAM_TOKEN });
      const bytes = Buffer.from(wire), split = bytes.indexOf(Buffer.from("안")) + 1;
      res.write(bytes.subarray(0, split)); res.end(bytes.subarray(split));
    });
    const id = randomUUID(), response = await relay.chat(body, id);
    expect(await response.text()).toBe(wire);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get(LOCAL_MODEL_RELAY_REQUEST_HEADER)).toBe(id);
    expect(received).toEqual({ authorization: `Bearer ${UPSTREAM_TOKEN}`, body, forwarded: undefined });
    const receipt = await relay.receipt(id);
    expect(receipt).toMatchObject({ state: "response_complete", requestId: id,
      requestHash: createHash("sha256").update(body).digest("hex"), responseHash: createHash("sha256").update(wire).digest("hex"),
      terminal: { models: [MODEL], finishReasons: ["stop"], usage: { total_tokens: 7 }, streamDone: true, observerComplete: true } });
    const text = JSON.stringify(receipt);
    expect(text).not.toContain(TOKEN); expect(text).not.toContain(UPSTREAM_TOKEN); expect(text).not.toContain("본문 확인");
    expect((await relay.chat(body, id)).status).toBe(409);
    expect(relay.service.relayHealth().nativeCapacityReady).toBe(false);
  });

  it("비스트리밍 JSON·모델 목록·upstream 오류 상태도 바꾸지 않는다", async () => {
    const json = JSON.stringify({ model: MODEL, choices: [{ finish_reason: "length", message: { content: "짧은 답" } }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
    const models = JSON.stringify({ data: [{ id: MODEL }] });
    let fail = false;
    const relay = await start((req, res) => {
      res.writeHead(fail ? 422 : 200, { "content-type": "application/json" });
      res.end(fail ? '{"error":{"message":"invalid input"}}' : req.url === "/v1/models" ? models : json);
    });
    expect(await (await relay.call("/v1/models")).text()).toBe(models);
    const id = randomUUID(), request = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "x" }], stream: false });
    expect(await (await relay.chat(request, id)).text()).toBe(json);
    expect((await relay.receipt(id)).terminal).toMatchObject({ models: [MODEL], finishReasons: ["length"], usage: { total_tokens: 6 } });
    fail = true;
    const response = await relay.chat(request);
    expect(response.status).toBe(422); expect(await response.text()).toBe('{"error":{"message":"invalid input"}}');
  });

  it("단일 추론 슬롯은 연결이 끊겨도 upstream이 끝날 때까지 유지하고 조회 가능한 기록을 남긴다", async () => {
    const started = gate(), release = gate(); let generations = 0, cancelled = false;
    const relay = await start(async (_req, res) => {
      generations++; res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": started\n\n");
      res.once("close", () => { if (!res.writableEnded) cancelled = true; }); started.release();
      await release.promise; res.end(finish);
    });
    const id = randomUUID();
    const request = http.request(`${relay.base}/v1/chat/completions`, { method: "POST", headers: {
      authorization: `Bearer ${TOKEN}`, "content-type": "application/json", [LOCAL_MODEL_RELAY_REQUEST_HEADER]: id } });
    request.on("error", () => {});
    const disconnected = new Promise<void>(resolve => request.once("response", response => response.once("data", () => { response.destroy(); resolve(); })));
    request.end(body); await started.promise; await disconnected;
    expect(relay.service.relayHealth().busy).toBe(true);
    expect((await relay.chat()).status).toBe(429);
    expect((await relay.receipt(id)).state).toBe("in_flight");
    expect(cancelled).toBe(false); expect(generations).toBe(1);
    release.release(); await waitUntil(() => !relay.service.relayHealth().busy);
    expect((await relay.receipt(id)).state).toBe("response_complete");
    expect(cancelled).toBe(false);
  });

  it("중간 EOF는 stop·DONE을 합성하지 않고 unknown을 재시작 뒤에도 보존한다", async () => {
    const started = gate(), release = gate();
    const relay = await start(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: {\"model\":\"qwen3.8-flash-next\"}\n\n");
      started.release(); await release.promise; res.destroy();
    });
    const id = randomUUID(), pending = relay.chat(body, id); await started.promise;
    const response = await pending; release.release();
    await expect(response.text()).rejects.toThrow();
    await waitUntil(() => relay.service.relayHealth().indeterminate);
    const receipt = await relay.receipt(id);
    expect(receipt).toMatchObject({ state: "indeterminate", error: "upstream_error", terminal: null });
    expect((await relay.chat()).status).toBe(503);
    relay.service.closeAllConnections(); await new Promise<void>(resolve => relay.service.close(() => resolve()));
    const restarted = await start((_req, res) => res.end("{}"), {}, relay.state);
    expect(restarted.service.relayHealth()).toMatchObject({ indeterminate: true, nativeCapacityReady: false });
    expect((await restarted.chat()).status).toBe(503);
  });

  it("timeout은 원격 생성 종료를 뜻하지 않아 새 전송을 차단한다", async () => {
    const started = gate(), release = gate(); let generating = false;
    const relay = await start(async (_req, res) => {
      generating = true; started.release(); await release.promise; generating = false; if (!res.destroyed) res.end("{}");
    }, { upstreamTimeoutMs: 30 });
    const id = randomUUID(), pending = relay.chat(body, id); await started.promise;
    expect((await pending).status).toBe(502);
    expect(generating).toBe(true);
    expect((await relay.receipt(id)).state).toBe("indeterminate");
    expect((await relay.chat()).status).toBe(503);
    release.release();
  });

  it("native readiness는 검증 hook과 실제 model·finish 관측이 모두 있어야 열린다", async () => {
    const relay = await start((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(finish); }, {
      verifyNativeReadiness: () => ({ ready: true, contractHash: "f".repeat(64), reason: "fake_contract_verified" }) });
    expect(relay.service.relayHealth().nativeCapacityReady).toBe(false);
    await (await relay.chat()).text();
    expect(relay.service.relayHealth().nativeCapacityReady).toBe(true);
    relay.service.drain(); expect((await relay.chat()).status).toBe(503);
    expect(relay.service.relayHealth().nativeCapacityReady).toBe(false);
    const missing = await start((_req, res) => res.end('{"model":"qwen3.8-flash-next","choices":[]}'), {
      verifyNativeReadiness: () => ({ ready: true, contractHash: "f".repeat(64), reason: "fake_contract_verified" }) });
    await (await missing.chat()).text(); expect(missing.service.relayHealth().nativeCapacityReady).toBe(false);
  });
});
