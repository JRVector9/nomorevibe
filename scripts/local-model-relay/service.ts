import http from "node:http";
import net from "node:net";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { LOCAL_MODEL_RELAY_PROTOCOL, LOCAL_MODEL_RELAY_REQUEST_HEADER, LOCAL_MODEL_UPSTREAM_HOST, LOCAL_MODEL_UPSTREAM_PORT,
  validRelayRequestId, type RelayNativeReadinessVerifier, type RelayReceipt } from "./protocol";
import type { RelayReceiptStore } from "./store";
import { relayResponseObserver } from "./observer";

export type LocalModelRelayOptions = {
  token: string;
  upstreamToken: string;
  allowFrom: readonly string[];
  model: string;
  relayRevision: string;
  deploymentRevision: string;
  store: RelayReceiptStore;
  /** 가짜 loopback upstream 시험용이다. 실행 entry에서는 항상8000이다. */
  upstreamPort?: number;
  maxBodyBytes?: number;
  upstreamTimeoutMs?: number;
  verifyNativeReadiness?: RelayNativeReadinessVerifier;
};

const plainIp = (value: string | undefined) => (value ?? "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
const safeSecret = (value: string) => value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
const supportedParameters = new Set(["model", "messages", "temperature", "top_p", "top_k", "min_p", "seed", "max_tokens",
  "max_completion_tokens", "stream", "stream_options", "response_format", "stop", "n", "presence_penalty", "frequency_penalty",
  "repetition_penalty", "enable_thinking", "chat_template_kwargs", "thinking_budget", "reasoning_effort"]);

function authorized(value: string | undefined, token: string): boolean {
  if (!value?.startsWith("Bearer ")) return false;
  const given = Buffer.from(value.slice(7)), expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function requestBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0, exceeded = false;
    const chunks: Buffer[] = [];
    req.on("data", (raw: Buffer) => {
      size += raw.length;
      if (size > limit) {
        if (!exceeded) reject(new Error("request_too_large"));
        exceeded = true; chunks.length = 0; return;
      }
      if (!exceeded) chunks.push(Buffer.from(raw));
    });
    req.once("end", () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    req.once("error", () => reject(new Error("invalid_request")));
    req.once("aborted", () => reject(new Error("invalid_request")));
  });
}

function waitForWritable(res: http.ServerResponse): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      res.off("drain", done); res.off("close", done); res.off("error", done); resolve();
    };
    res.once("drain", done); res.once("close", done); res.once("error", done);
  });
}

export function createLocalModelRelay(options: LocalModelRelayOptions) {
  if (options.token.length < 32 || !safeSecret(options.token) || !safeSecret(options.upstreamToken) || options.token === options.upstreamToken)
    throw new Error("relay_separate_tokens_required");
  if (!options.allowFrom.length || options.allowFrom.some(ip => !net.isIP(ip))) throw new Error("relay_allowlist_required");
  const port = options.upstreamPort ?? LOCAL_MODEL_UPSTREAM_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("relay_invalid_upstream_port");
  const limit = options.maxBodyBytes ?? 8 * 1024 * 1024;
  const timeout = options.upstreamTimeoutMs ?? 90_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 90_000)
    throw new Error("relay_invalid_limit");
  const allow = new Set(options.allowFrom.map(plainIp));
  const generation = randomUUID();
  let activeRequestId: string | null = null, indeterminate = options.store.hasUnsettled(), draining = false;
  let lastReceipt: RelayReceipt | null = null;
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    if (res.destroyed) return;
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  const refuse = (res: http.ServerResponse, status: number, code: string) => send(res, status, { error: { code } });
  const health = () => {
    const context = { relayRevision: options.relayRevision, deploymentRevision: options.deploymentRevision,
      model: options.model, indeterminate, activeRequestId, lastReceipt };
    let verified: ReturnType<RelayNativeReadinessVerifier> | undefined;
    try { verified = options.verifyNativeReadiness?.(context); } catch { verified = undefined; }
    const terminal = lastReceipt?.terminal;
    const observed = lastReceipt?.state === "response_complete" && terminal?.observerComplete
      && terminal.models.length === 1 && terminal.models[0] === options.model && terminal.finishReasons.length > 0
      && terminal.finishReasons.every(value => ["stop", "length", "tool_calls", "content_filter", "function_call"].includes(value))
      && typeof terminal.usage?.total_tokens === "number" && Number.isSafeInteger(terminal.usage.total_tokens) && terminal.usage.total_tokens >= 0;
    return { protocol: LOCAL_MODEL_RELAY_PROTOCOL, relayRevision: options.relayRevision, deploymentRevision: options.deploymentRevision,
      relayGeneration: generation, relayReady: !draining && !indeterminate, busy: activeRequestId !== null, indeterminate, draining,
      nativeCapacityReady: Boolean(!draining && !indeterminate && !activeRequestId && observed
        && options.deploymentRevision !== "unverified" && verified?.ready
        && verified.contractHash && /^[0-9a-f]{64}$/.test(verified.contractHash)),
      nativeContractHash: verified?.contractHash ?? null, nativeReadinessReason: verified?.reason ?? "native_contract_unverified" };
  };

  const server = http.createServer(async (req, res) => {
    if (!allow.has(plainIp(req.socket.remoteAddress))) return refuse(res, 403, "forbidden");
    if (!authorized(req.headers.authorization, options.token)) return refuse(res, 401, "unauthorized");
    // query·absolute URL·중복 slash도 별도 경로로 보아 임의 upstream 설정을 받지 않는다.
    if (req.method === "GET" && req.url === "/v1/health") return send(res, 200, health());
    const receiptPath = /^\/v1\/requests\/([0-9a-f-]+)$/.exec(req.url ?? "");
    if (req.method === "GET" && receiptPath && validRelayRequestId(receiptPath[1])) {
      try {
        const receipt = options.store.get(receiptPath[1]);
        return receipt ? send(res, 200, receipt) : refuse(res, 404, "receipt_not_found");
      } catch { return refuse(res, 503, "receipt_unavailable"); }
    }
    const inference = req.method === "POST" && req.url === "/v1/chat/completions";
    if (!inference && !(req.method === "GET" && req.url === "/v1/models")) return refuse(res, 404, "not_found");
    if (draining) return refuse(res, 503, "draining");
    if (inference && indeterminate) return refuse(res, 503, "upstream_indeterminate");
    if (inference && activeRequestId) return refuse(res, 429, "busy");
    let body: Buffer = Buffer.alloc(0), model = "";
    if (inference) {
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) return refuse(res, 415, "json_required");
      try {
        body = await requestBody(req, limit);
        const input: unknown = JSON.parse(body.toString("utf8"));
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
        const object = input as Record<string, unknown>;
        if (Object.keys(object).some(key => !supportedParameters.has(key)) || object.model !== options.model
          || !Array.isArray(object.messages) || !object.messages.length || (object.n !== undefined && object.n !== 1)
          || (object.stream !== undefined && typeof object.stream !== "boolean")) throw new Error();
        model = options.model;
      } catch (error) { return refuse(res, error instanceof Error && error.message === "request_too_large" ? 413 : 400,
        error instanceof Error && error.message === "request_too_large" ? "request_too_large" : "invalid_request"); }
    }
    if (inference && (activeRequestId || indeterminate || draining)) return refuse(res, 429, "busy");
    const suppliedId = req.headers[LOCAL_MODEL_RELAY_REQUEST_HEADER];
    if (suppliedId !== undefined && !validRelayRequestId(suppliedId)) return refuse(res, 400, "invalid_request_id");
    const requestId = typeof suppliedId === "string" ? suppliedId : randomUUID();
    let receipt: RelayReceipt | null = null;
    if (inference) {
      try {
        if (options.store.get(requestId)) return refuse(res, 409, "duplicate_request_id");
        receipt = { protocol: 1, requestId, relayGeneration: generation, relayRevision: options.relayRevision,
          deploymentRevision: options.deploymentRevision, requestModel: model, requestHash: createHash("sha256").update(body).digest("hex"),
          startedAt: new Date().toISOString(), state: "in_flight", endedAt: null, upstreamStatus: null, responseHash: null,
          responseBytes: 0, terminal: null, error: null };
        options.store.begin(receipt);
        activeRequestId = requestId;
      } catch { indeterminate = true; return refuse(res, 503, "receipt_unavailable"); }
      res.setHeader(LOCAL_MODEL_RELAY_REQUEST_HEADER, requestId);
    }
    let clientGone = false, settled = false;
    res.once("close", () => { clientGone = !res.writableEnded; });
    res.once("error", () => { clientGone = true; });
    const responseHash = createHash("sha256");
    let responseBytes = 0;
    const finish = (state: "response_complete" | "indeterminate", error: RelayReceipt["error"], terminal: RelayReceipt["terminal"]) => {
      if (settled) return;
      settled = true;
      if (receipt) {
        receipt = { ...receipt, state, error, endedAt: new Date().toISOString(), responseBytes,
          responseHash: responseHash.digest("hex"), terminal };
        try { options.store.finish(receipt); lastReceipt = receipt; }
        catch { indeterminate = true; }
        if (state === "indeterminate") indeterminate = true;
        activeRequestId = null;
      }
    };
    const upstream = http.request({ hostname: LOCAL_MODEL_UPSTREAM_HOST, port, path: inference ? "/v1/chat/completions" : "/v1/models",
      method: inference ? "POST" : "GET", agent: false, headers: { authorization: `Bearer ${options.upstreamToken}`,
        accept: inference ? "application/json, text/event-stream" : "application/json",
        ...(inference ? { "content-type": "application/json", "content-length": body.length,
          "x-request-id": requestId } : {}) } }, async response => {
      if (receipt) receipt.upstreamStatus = response.statusCode ?? null;
      const contentType = response.headers["content-type"] ?? "application/octet-stream";
      const observer = relayResponseObserver(contentType.includes("text/event-stream"));
      if (!clientGone && !res.destroyed) res.writeHead(response.statusCode ?? 502, { "content-type": contentType, "cache-control": "no-store" });
      try {
        for await (const raw of response) {
          const chunk = Buffer.from(raw);
          responseBytes += chunk.length; responseHash.update(chunk); observer.chunk(chunk);
          if (!clientGone && !res.destroyed && !res.write(chunk)) {
            await waitForWritable(res);
          }
        }
        if (!response.complete) throw new Error("incomplete_upstream");
        finish("response_complete", null, observer.end());
        if (!clientGone && !res.destroyed) res.end();
      } catch {
        finish("indeterminate", "upstream_error", null);
        if (!res.destroyed) res.destroy();
      }
    });
    const timer = setTimeout(() => { upstream.destroy(); finish("indeterminate", "upstream_timeout", null); }, timeout);
    timer.unref();
    upstream.once("close", () => clearTimeout(timer));
    upstream.once("error", () => {
      finish("indeterminate", "upstream_error", null);
      if (!clientGone && !res.destroyed) {
        if (res.headersSent) res.destroy(); else refuse(res, 502, "upstream_unavailable");
      }
    });
    upstream.end(inference ? body : undefined);
  });
  server.headersTimeout = 10_000; server.requestTimeout = 30_000; server.keepAliveTimeout = 5_000;
  return Object.assign(server, { relayHealth: health, drain: () => { draining = true; } });
}
