import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalModelRelay, type LocalModelRelayOptions } from "@/scripts/local-model-relay/service";
import { fileRelayReceiptStore } from "@/scripts/local-model-relay/store";
import { LOCAL_MODEL_RELAY_DEADLINE_RELEASE_SUFFIX, LOCAL_MODEL_RELAY_REQUEST_HEADER, type RelayReceipt } from "@/scripts/local-model-relay/protocol";
import { releaseRelayAfterEngineDeadline } from "@/scripts/local-model-relay/deadline-release";
import { checkRelayBoundaryPending } from "@/scripts/local-model-relay/boundary-reconcile";

const TOKEN = "relay-private-token-" + "a".repeat(40);
const UPSTREAM_TOKEN = "upstream-private-key-" + "b".repeat(40);
const MODEL = "qwen3.8-flash-next";
const servers: http.Server[] = [], directories: string[] = [];
const finish = `data: ${JSON.stringify({ model: MODEL, choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\ndata: [DONE]\n\n`;
const body = (extra: Record<string, unknown> = {}) => JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "x" }], stream: true, ...extra });

const listen = async (server: http.Server) => {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};
const waitUntil = async (check: () => boolean, limitMs = 6_000) => {
  const until = Date.now() + limitMs;
  while (Date.now() < until) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("condition_not_reached");
};
const tempDir = () => { const directory = mkdtempSync(path.join(os.tmpdir(), "nmv-relay-deadline-")); directories.push(directory); return directory; };

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function start(handler: http.RequestListener, over: Partial<LocalModelRelayOptions> = {}, state = tempDir()) {
  const upstreamPort = await listen(http.createServer(handler));
  const service = createLocalModelRelay({ token: TOKEN, upstreamToken: UPSTREAM_TOKEN, allowFrom: ["127.0.0.1"], model: MODEL,
    relayRevision: "c".repeat(40), deploymentRevision: "d".repeat(40), engineBoundEffectiveAt: "2026-01-01T00:00:00.000Z", store: fileRelayReceiptStore(state), upstreamPort, ...over });
  const base = `http://127.0.0.1:${await listen(service)}`;
  const chat = (text: string, id = randomUUID()) => fetch(base + "/v1/chat/completions", { method: "POST", headers: {
    authorization: `Bearer ${TOKEN}`, "content-type": "application/json", [LOCAL_MODEL_RELAY_REQUEST_HEADER]: id }, body: text });
  return { service, state, chat };
}

function seedIndeterminate(directory: string, startedAt: string, state: RelayReceipt["state"] = "indeterminate") {
  const requestId = randomUUID(), relayGeneration = randomUUID();
  const receipt: RelayReceipt = { protocol: 1, requestId, relayGeneration, relayRevision: "c".repeat(40), deploymentRevision: "d".repeat(40),
    requestModel: MODEL, requestHash: "e".repeat(64), startedAt, state, endedAt: state === "in_flight" ? null : startedAt, upstreamStatus: null,
    responseHash: null, responseBytes: 0, terminal: null, error: state === "in_flight" ? null : "upstream_timeout" };
  writeFileSync(path.join(directory, "active.json"), JSON.stringify({ requestId, relayGeneration }), { mode: 0o600 });
  writeFileSync(path.join(directory, `${requestId}.json`), JSON.stringify(receipt) + "\n", { mode: 0o600 });
  return { requestId, receiptBytes: readFileSync(path.join(directory, `${requestId}.json`)) };
}

describe("relay 기한 사다리: 엔진 < relay", () => {
  it("refuses a relay deadline that is not longer than the declared engine deadline plus skew", () => {
    const store = fileRelayReceiptStore(tempDir());
    const base = { token: TOKEN, upstreamToken: UPSTREAM_TOKEN, allowFrom: ["127.0.0.1"], model: MODEL,
      relayRevision: "c".repeat(40), deploymentRevision: "d".repeat(40), engineBoundEffectiveAt: "2026-01-01T00:00:00.000Z", store };
    expect(() => createLocalModelRelay({ ...base, upstreamTimeoutMs: 30_000, engineDeadlineMs: 28_000 })).toThrow("relay_deadline_order_invalid");
    expect(() => createLocalModelRelay({ ...base, upstreamTimeoutMs: 30_000, engineDeadlineMs: 27_999 })).not.toThrow();
  });

  it("re-opens itself after a timeout once the declared engine bound has elapsed, keeping the original receipt", async () => {
    let calls = 0;
    const relay = await start((req, res) => {
      calls++;
      if (calls === 1) return; // hung engine: never answers
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end(finish);
    }, { upstreamTimeoutMs: 2_100, engineDeadlineMs: 50 });
    const id = randomUUID();
    const first = await relay.chat(body(), id).catch(() => null);
    if (first) await first.text().catch(() => "");
    await waitUntil(() => relay.service.relayHealth().lastDeadlineRelease === id);
    expect(relay.service.relayHealth()).toMatchObject({ indeterminate: false, relayReady: true, engineDeadlineMs: 50 });
    const receipt = JSON.parse(readFileSync(path.join(relay.state, `${id}.json`), "utf8")) as RelayReceipt;
    expect(receipt).toMatchObject({ state: "indeterminate", error: "upstream_timeout", terminal: null });
    const archive = JSON.parse(readFileSync(path.join(relay.state, `${id}${LOCAL_MODEL_RELAY_DEADLINE_RELEASE_SUFFIX}`), "utf8"));
    expect(archive).toMatchObject({ kind: "engine_deadline_elapsed", requestId: id, engineDeadlineMs: 50, skewMs: 2_000, engineBoundEffectiveAt: "2026-01-01T00:00:00.000Z" });
    expect(existsSync(path.join(relay.state, "active.json"))).toBe(false);
    // A later DB boundary release for the same request still finds the relay side done.
    expect(() => checkRelayBoundaryPending(relay.state, id)).not.toThrow();
    const next = await relay.chat(body());
    expect(next.status).toBe(200); await next.text();
  }, 10_000);

  it("keeps the old reject-all behaviour when no engine deadline is declared", async () => {
    const relay = await start(() => { /* hung */ }, { upstreamTimeoutMs: 30 });
    const response = await relay.chat(body()).catch(() => null);
    if (response) await response.text().catch(() => "");
    await waitUntil(() => relay.service.relayHealth().indeterminate);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(relay.service.relayHealth()).toMatchObject({ indeterminate: true, relayReady: false, lastDeadlineRelease: null });
    expect((await relay.chat(body())).status).toBe(503);
  });

  it("releases a pending unknown at restart only after start + bound + skew", () => {
    const directory = tempDir();
    const started = new Date(Date.now() - 10_000).toISOString();
    const { requestId, receiptBytes } = seedIndeterminate(directory, started);
    const policy = { engineDeadlineMs: 9_000, skewMs: 2_000, enforcedAfterMs: Date.parse("2026-01-01T00:00:00.000Z") };
    const waiting = releaseRelayAfterEngineDeadline(directory, requestId, policy);
    expect(waiting).toMatchObject({ kind: "waiting", requestId });
    expect(existsSync(path.join(directory, "active.json"))).toBe(true);
    expect(releaseRelayAfterEngineDeadline(directory, requestId, policy, Date.parse(started) + 11_000)).toEqual({ kind: "released", requestId });
    expect(readFileSync(path.join(directory, `${requestId}.json`)).equals(receiptBytes)).toBe(true);
    expect(releaseRelayAfterEngineDeadline(directory, requestId, policy)).toEqual({ kind: "already_released", requestId });
  });

  it("never releases an in-flight receipt or a mismatched request id", () => {
    const directory = tempDir();
    const { requestId } = seedIndeterminate(directory, new Date(Date.now() - 600_000).toISOString(), "in_flight");
    expect(() => releaseRelayAfterEngineDeadline(directory, requestId, { engineDeadlineMs: 1_000, skewMs: 2_000, enforcedAfterMs: Date.parse("2026-01-01T00:00:00.000Z") }))
      .toThrow("relay_recovery_request_mismatch");
    expect(() => releaseRelayAfterEngineDeadline(directory, randomUUID(), { engineDeadlineMs: 1_000, skewMs: 2_000, enforcedAfterMs: Date.parse("2026-01-01T00:00:00.000Z") }))
      .toThrow("relay_recovery_request_mismatch");
    expect(existsSync(path.join(directory, "active.json"))).toBe(true);
  });

  it("re-opens at startup when the stored unknown is already past its engine bound", async () => {
    const directory = tempDir();
    const { requestId } = seedIndeterminate(directory, new Date(Date.now() - 60_000).toISOString());
    const relay = await start((req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(finish); },
      { upstreamTimeoutMs: 30_000, engineDeadlineMs: 20_000 }, directory);
    await waitUntil(() => relay.service.relayHealth().lastDeadlineRelease === requestId);
    expect(relay.service.relayHealth()).toMatchObject({ indeterminate: false, relayReady: true });
  });

  it("refuses requests without a bounded output length before any upstream call", async () => {
    let calls = 0;
    const relay = await start((req, res) => { calls++; res.writeHead(200, { "content-type": "text/event-stream" }); res.end(finish); },
      { maxOutputTokens: 100 });
    for (const text of [body(), body({ max_tokens: 101 }), body({ max_tokens: 50, max_completion_tokens: 500 }), body({ max_tokens: 0 })]) {
      const response = await relay.chat(text);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "output_bound_required" } });
    }
    expect(calls).toBe(0);
    expect(relay.service.relayHealth()).toMatchObject({ indeterminate: false, busy: false });
    const ok = await relay.chat(body({ max_tokens: 100 }));
    expect(ok.status).toBe(200); await ok.text();
    expect(calls).toBe(1);
  });
});


it("never applies a newly declared engine bound retroactively to a stored unknown", () => {
  const directory = tempDir();
  const { requestId, receiptBytes } = seedIndeterminate(directory, "2026-10-27T00:00:00.000Z");
  expect(() => releaseRelayAfterEngineDeadline(directory, requestId,
    { engineDeadlineMs: 1000, skewMs: 2000, enforcedAfterMs: Date.parse("2026-10-28T00:00:00.000Z") }))
    .toThrow("relay_engine_bound_not_effective_at_dispatch");
  expect(existsSync(path.join(directory, "active.json"))).toBe(true);
  expect(readFileSync(path.join(directory, `${requestId}.json`)).equals(receiptBytes)).toBe(true);
});


it("keeps the active marker if an existing release archive does not match its receipt", () => {
  const directory = tempDir();
  const { requestId } = seedIndeterminate(directory, "2026-10-27T00:00:00.000Z");
  writeFileSync(path.join(directory, `${requestId}${LOCAL_MODEL_RELAY_DEADLINE_RELEASE_SUFFIX}`), JSON.stringify({ requestId }));
  expect(() => releaseRelayAfterEngineDeadline(directory, requestId, { engineDeadlineMs: 1000, skewMs: 2000, enforcedAfterMs: 0 }))
    .toThrow("relay_deadline_archive_mismatch");
  expect(existsSync(path.join(directory, "active.json"))).toBe(true);
});
