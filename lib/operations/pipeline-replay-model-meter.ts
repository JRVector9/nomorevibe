import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, Dispatcher, getGlobalDispatcher, request, setGlobalDispatcher } from "undici";
import { FIXED_INPUT_UPSTREAM_PATH } from "./pipeline-replay-fixed-input";

export type ReplayMeterLimits = { maxCalls: number; maxTokens: number; perCallTokenUpperBound: number };
export type ReplayMeterStop = "call_cap" | "token_cap" | "per_call_bound_exceeded";
export type ReplayMeterStats = { calls: number; refused: number; upstreamFailed: number; indeterminate: number; maxInFlight: number;
  usageKnownCalls: number; reportedInputTokens: number; reportedOutputTokens: number; chargedTokens: number; egressRejected: number;
  upstreamReportedCalls: number; upstreamReportedTokens: number;
  models: { model: string; calls: number }[]; usageProvenance: "reported_unverified" };
/** 구간 끝 drain 결과: 정지 순간 진행 중이던 호출 수, drain 상한까지 끝나지 않아 끊은 호출 수, 기다린 시간. */
export type ReplayMeterDrain = { inFlightAtStop: number; cutAtLimit: number; waitedMs: number };
export type ReplayModelMeter = { readonly origin: string; stats(): ReplayMeterStats;
  /**
   * 구간 끝: 이후 새 호출은 upstream으로 보내지 않고 거부로 센다. 이미 보낸 호출은 호출자(워커)가 끊어도 deadlineAt까지 upstream이 끝나게 두어
   * usage를 남긴다. 그때까지 끝나지 않은 호출은 끊는다(indeterminate, 예약 전체 청구). 진행 중 호출이 모두 정리된 뒤 돌아온다.
   */
  drain(deadlineAt: number): Promise<ReplayMeterDrain>; close(): Promise<void> };

const MAX_REQUEST_BYTES = 2 * 1024 * 1024, MAX_RESPONSE_BYTES = 4 * 1024 * 1024, UPSTREAM_TIMEOUT_MS = 10 * 60_000;

async function body(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) return null;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function usage(bytes: Buffer): { input: number; output: number } | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    const safe = (count: unknown): count is number => typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
    const input = value?.usage?.prompt_tokens, output = value?.usage?.completion_tokens;
    return safe(input) && safe(output) && Number.isSafeInteger(input + output) ? { input, output } : null;
  } catch { return null; }
}
/** budget 증거(PR01b-9)용: native terminal과 같은 규칙 — usage_provenance=upstream_reported, 정수 셋, 입력+출력=합. */
function upstreamReportedTotal(bytes: Buffer): number | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as { usage_provenance?: unknown; usage?: Record<string, unknown> };
    const safe = (count: unknown): count is number => typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
    const { prompt_tokens: input, completion_tokens: output, total_tokens: total } = value?.usage ?? {};
    return value?.usage_provenance === "upstream_reported" && safe(input) && safe(output) && safe(total)
      && Number.isSafeInteger(input + output) && input + output === total ? total : null;
  } catch { return null; }
}

/**
 * 실모델 호출의 사전 상한. 호출마다 호출당 상한만큼 토큰을 먼저 예약하고, 끝나면 응답의 usage(게이트웨이 보고값 —
 * 출처 미검증)로 정산한다. usage가 없거나 연결이 끊긴 호출은 예약 전체를 그대로 청구한다. 상한에 닿으면
 * onStop을 먼저 부르고 이후 호출은 upstream으로 보내지 않는다. 요청·응답 본문은 저장하지 않는다.
 */
export async function startReplayModelMeter(options: { upstream: string; limits: ReplayMeterLimits;
  onStop: (reason: ReplayMeterStop) => void }): Promise<ReplayModelMeter> {
  const { upstream, limits, onStop } = options;
  const upstreamAgent = new Agent({ connections: 64 });
  const stats = { calls: 0, refused: 0, upstreamFailed: 0, indeterminate: 0, maxInFlight: 0, usageKnownCalls: 0,
    reportedInputTokens: 0, reportedOutputTokens: 0, chargedTokens: 0, egressRejected: 0, upstreamReportedCalls: 0, upstreamReportedTokens: 0 };
  const models = new Map<string, number>();
  let inFlight = 0, stopped = false, draining = false, cutting = false, cut = 0;
  const active = new Set<AbortController>(), idle: (() => void)[] = [];
  const stop = (reason: ReplayMeterStop) => { if (!stopped) { stopped = true; onStop(reason); } };
  const reply = (res: ServerResponse, status: number, payload: Buffer | string, type = "application/json") => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { "content-type": type }); res.end(payload);
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // 거부는 upstream으로 나가지 않으므로 실행을 멈추지 않고 세기만 한다(결과에 replay_egress_rejected가 붙어 비교 불가가 된다).
    if (req.method !== "POST" || req.url !== FIXED_INPUT_UPSTREAM_PATH) { stats.egressRejected++; return reply(res, 404, '{"error":"replay_route_rejected"}'); }
    const payload = await body(req, MAX_REQUEST_BYTES);
    if (!payload) { stats.refused++; return reply(res, 413, '{"error":"replay_request_too_large"}'); }
    // 구간 끝 뒤 새 호출은 보내지 않는다. 거부로 세므로 결과에 replay_calls_refused가 붙는다.
    if (draining) { stats.refused++; return reply(res, 503, '{"error":"replay_window_ended"}'); }
    // 예약: 호출 수와 (정산된 토큰 + 진행 중 예약 + 이번 예약)이 상한 안이어야 보낸다.
    if (stopped || stats.calls + 1 > limits.maxCalls) { stats.refused++; stop("call_cap"); return reply(res, 503, '{"error":"replay_cap_reached"}'); }
    if (stats.chargedTokens + (inFlight + 1) * limits.perCallTokenUpperBound > limits.maxTokens) {
      stats.refused++; stop("token_cap"); return reply(res, 503, '{"error":"replay_cap_reached"}');
    }
    stats.calls++; inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    let model = "unknown";
    try {
      const parsed = JSON.parse(payload.toString("utf8")) as { model?: unknown };
      if (typeof parsed.model === "string" && parsed.model.trim() && parsed.model.length <= 160) model = parsed.model.trim();
    } catch { /* 본문 판정은 게이트웨이와 심사 코드가 한다. */ }
    if (models.size < 32 || models.has(model)) models.set(model, (models.get(model) ?? 0) + 1);
    if (stats.calls >= limits.maxCalls) stop("call_cap");
    // 구간 안에서 호출자가 끊으면 바로 끊는다. drain 중에는 호출자가 끊어도 upstream이 끝나게 둔다(usage를 남긴다).
    const abort = new AbortController(), closed = () => { if (!res.writableEnded && !draining) abort.abort(); };
    res.once("close", closed); active.add(abort);
    let charge = limits.perCallTokenUpperBound;
    try {
      const response = await request(`${upstream}${FIXED_INPUT_UPSTREAM_PATH}`, { method: "POST", dispatcher: upstreamAgent,
        headers: { "content-type": "application/json", ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) },
        body: payload, signal: abort.signal, headersTimeout: UPSTREAM_TIMEOUT_MS, bodyTimeout: UPSTREAM_TIMEOUT_MS });
      const bytes = await body(response.body, MAX_RESPONSE_BYTES);
      if (!bytes) { stats.indeterminate++; return reply(res, 502, '{"error":"replay_response_too_large"}'); }
      const counted = response.statusCode === 200 ? usage(bytes) : null;
      const reported = response.statusCode === 200 ? upstreamReportedTotal(bytes) : null;
      if (reported !== null) { stats.upstreamReportedCalls++; stats.upstreamReportedTokens += reported; }
      if (counted) {
        stats.usageKnownCalls++; stats.reportedInputTokens += counted.input; stats.reportedOutputTokens += counted.output;
        charge = counted.input + counted.output;
        // 보고값이 호출당 상한을 넘으면 사전 상한 계약이 깨진 것이다. 실제값을 청구하고 실행을 멈춘다.
        if (charge > limits.perCallTokenUpperBound) stop("per_call_bound_exceeded");
      }
      const type = response.headers["content-type"];
      reply(res, response.statusCode, bytes, typeof type === "string" ? type : "application/json");
    } catch {
      // 끊긴 호출은 upstream이 계속 일했는지 알 수 없다. 예약 전체를 그대로 청구한다.
      if (abort.signal.aborted) { stats.indeterminate++; if (cutting) cut++; } else stats.upstreamFailed++;
      reply(res, 502, '{"error":"replay_upstream_failed"}');
    } finally {
      res.off("close", closed); active.delete(abort);
      inFlight--; stats.chargedTokens += charge;
      if (stats.chargedTokens >= limits.maxTokens) stop("token_cap");
      if (!inFlight) for (const resolve of idle.splice(0)) resolve();
    }
  };
  const server = createServer((req, res) => { void handle(req, res).catch(() => reply(res, 500, '{"error":"replay_meter_failed"}')); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    stats: () => ({ ...stats, models: [...models].map(([model, calls]) => ({ model, calls })), usageProvenance: "reported_unverified" }),
    drain: async deadlineAt => {
      draining = true;
      const startedAt = Date.now(), inFlightAtStop = inFlight, settled = () => new Promise<void>(resolve => { if (inFlight) idle.push(resolve); else resolve(); });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<"limit">(resolve => { timer = setTimeout(() => resolve("limit"), Math.max(0, deadlineAt - Date.now())); });
      if (await Promise.race([settled(), limit]) === "limit") { cutting = true; for (const abort of active) abort.abort(); await settled(); }
      clearTimeout(timer);
      return { inFlightAtStop, cutAtLimit: cut, waitedMs: Date.now() - startedAt };
    },
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await upstreamAgent.close();
    },
  };
}

/** 허용한 모델 origin의 POST /v1/chat/completions만 계량기로 돌리고 나머지 HTTP는 프로세스 안에서 막는다. */
class ReplayEgressGuard extends Dispatcher {
  constructor(private readonly allowed: string, private readonly meterOrigin: string, private readonly agent: Agent,
    private readonly rejected: () => void) { super(); }
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    let origin = "";
    try { origin = new URL(String(options.origin)).origin; } catch { /* 아래에서 거부한다. */ }
    if (origin !== this.allowed || String(options.method).toUpperCase() !== "POST" || options.path !== FIXED_INPUT_UPSTREAM_PATH) {
      this.rejected();
      throw new Error("replay_egress_rejected");
    }
    return this.agent.dispatch({ ...options, origin: this.meterOrigin }, handler);
  }
  async close(): Promise<void> { await this.agent.close(); }
  async destroy(): Promise<void> { await this.agent.destroy(); }
}

/**
 * 전역 fetch(undici·Node 내장 공용 dispatcher)를 replay 동안 가둔다. 반환한 함수가 원래 dispatcher를 되돌린다.
 * DB 드라이버(net 소켓)와 계량기 자신의 upstream 연결(전용 Agent)은 영향을 받지 않는다.
 */
export function installReplayEgressGuard(allowed: string, meter: ReplayModelMeter, rejected: () => void): () => Promise<void> {
  const previous = getGlobalDispatcher(), agent = new Agent();
  setGlobalDispatcher(new ReplayEgressGuard(allowed, meter.origin, agent, rejected));
  return async () => { setGlobalDispatcher(previous); await agent.close(); };
}
