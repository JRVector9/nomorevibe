import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { logger } from "@/lib/observability/logger";

/**
 * provider circuit breaker(PR06e, 설계 §6 "transient 실패는 항목 backoff, provider 장애는 해당 provider circuit breaker 로 분리").
 * 독립 consumer(AI1·AI2·배경 줄)의 claim 전 관문이다. 프로세스 안 상태라 다른 프로세스와 나누지 않는다(DB 공유 아님).
 * 기술 장애만 센다 — 모델 판정·입력·취소는 세지 않는다. 열린 동안은 새 항목을 claim 하지 않고 기다리므로 항목 실패 수·재시도가 늘지 않는다.
 * 항목별 실패 상한·재시도·timeout·품질 기준은 그대로이고 이 관문만 더한다. openMs 뒤 시험 하나(half-open)로 닫거나 다시 연다.
 * 기본 비활성: 한도는 실측 전 기본값을 두지 않는다 — 켤 때 둘 다 명시한다(HOST_BUDGET_ENFORCEMENT 와 같은 규칙).
 */
const configSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("disabled") }),
  z.strictObject({ mode: z.literal("enabled"), failures: z.number().int().min(1).max(100), openMs: z.number().int().min(1_000).max(3_600_000) }),
]);
export type ProviderCircuitConfig = z.infer<typeof configSchema>;
export function providerCircuitConfig(env: Readonly<Record<string, string | undefined>>): ProviderCircuitConfig {
  const raw = env.PROVIDER_CIRCUIT_BREAKER;
  if (raw === undefined) return { mode: "disabled" };
  try {
    if (Buffer.byteLength(raw, "utf8") > 4096) throw new Error();
    return configSchema.parse(JSON.parse(raw));
  } catch { throw new Error("provider_circuit_breaker_invalid"); }
}

/**
 * provider 쪽 기술 장애 — 기존 분류의 합이다. 2차 심사 일시 오류(SECOND_REVIEW_TRANSIENT_ERRORS), 심사자 없음(product-audit REVIEWER_DOWN),
 * gateway 막힘(search-profile·search-verify·tagline 의 GATEWAY_DOWN)과 gateway 5xx. cli_error 는 입력 탓일 수 있어 넣지 않는다.
 */
const PROVIDER_DOWN: ReadonlySet<string> = new Set(["timeout", "gateway_error", "rate_limited", "budget", "not_configured", "auth",
  "missing_cli", "model_unavailable", "no_key", "rate_limit", "network"]);
/**
 * native AI1·AI2 게이트웨이가 계약(응답 envelope·terminal: responseModel·error 키·chat.completion 모양 등)을 어긴 응답의 detail
 * (agent-review-gateway). 결과 모양은 기존 invalid_output 그대로지만 모델 판정 실패가 아니라 게이트웨이 쪽 기술 오류다 —
 * 회로에는 provider 장애로 세고 AI1 시도 수로는 세지 않는다. 내용이 판정이 아닌 것(invalid_json·schema 등)은 그대로 판정 오류다.
 */
export const NATIVE_TERMINAL_FAILURE = "invalid_native_terminal";
type ProviderResult = { ok: boolean; error?: string; detail?: string };
export function nativeTerminalFailure(result: ProviderResult): boolean {
  return !result.ok && result.error === "invalid_output" && result.detail === NATIVE_TERMINAL_FAILURE;
}
export type ProviderOutcome = "up" | "down" | "none";
export function providerOutcome(result: ProviderResult): ProviderOutcome {
  if (result.ok) return "up";
  if (nativeTerminalFailure(result)) return "down";
  return typeof result.error === "string" && (PROVIDER_DOWN.has(result.error) || /^http_5\d\d$/.test(result.error)) ? "down" : "none";
}

export type ProviderCircuitAdmission = { admitted: true; record: (result: ProviderResult) => void; done: () => void }
  | { admitted: false; reason: "provider_circuit_open" };
export type ProviderCircuits = { admit: (key: string) => ProviderCircuitAdmission };
type State = { phase: "closed"; failures: number } | { phase: "open"; until: number } | { phase: "half_open"; trial: boolean };
type Log = (event: string, fields: Record<string, unknown>) => void;
const defaultLog: Log = (event, fields) => event === "provider_circuit.opened" || event === "provider_circuit.reopened"
  ? logger.warn(event, fields) : logger.info(event, fields);

/** key 마다 따로 센다(AI1 줄·AI2 provider·배경 job). 시각은 단조 시계다. 한 key 의 시험은 늘 하나뿐이다 */
export function createProviderCircuits(config: Extract<ProviderCircuitConfig, { mode: "enabled" }>,
  options: { now?: () => number; log?: Log } = {}): ProviderCircuits {
  const parsed = configSchema.parse(config);
  if (parsed.mode !== "enabled") throw new Error("provider_circuit_breaker_invalid");
  const { failures: threshold, openMs } = parsed, now = options.now ?? (() => performance.now()), log = options.log ?? defaultLog;
  const states = new Map<string, State>();
  const open = (key: string, event: string, fields: Record<string, unknown>) => {
    states.set(key, { phase: "open", until: now() + openMs });
    log(event, { key, ...fields, openMs });
  };
  return { admit: key => {
    const state = states.get(key) ?? { phase: "closed", failures: 0 };
    let trial = false, settled = false;
    if (state.phase === "open") {
      if (now() < state.until) return { admitted: false, reason: "provider_circuit_open" };
      states.set(key, { phase: "half_open", trial: true }); trial = true;
      log("provider_circuit.half_open", { key });
    } else if (state.phase === "half_open") {
      if (state.trial) return { admitted: false, reason: "provider_circuit_open" };
      states.set(key, { phase: "half_open", trial: true }); trial = true;
    }
    return { admitted: true,
      record: result => {
        const outcome = providerOutcome(result);
        if (outcome === "none") return;
        // 시험의 첫 판정이 닫힘/다시 열림을 정한다. 그 뒤 결과는 닫힌 상태에서만 센다
        if (trial && !settled) {
          settled = true;
          if (outcome === "up") { states.set(key, { phase: "closed", failures: 0 }); log("provider_circuit.closed", { key }); }
          else open(key, "provider_circuit.reopened", { error: result.error });
          return;
        }
        const current = states.get(key) ?? { phase: "closed", failures: 0 };
        // 열리기 전에 들어온 단위의 늦은 결과는 열림·시험을 바꾸지 않는다
        if (current.phase !== "closed") return;
        if (outcome === "up") { states.set(key, { phase: "closed", failures: 0 }); return; }
        const failures = current.failures + 1;
        if (failures >= threshold) open(key, "provider_circuit.opened", { failures, error: result.error });
        else states.set(key, { phase: "closed", failures });
      },
      // 판정 없이 끝난 시험(호출 없음·취소·판정 오류)은 닫지 않고 다음 단위에 시험을 넘긴다
      done: () => {
        if (!trial || settled) return;
        settled = true;
        if (states.get(key)?.phase === "half_open") states.set(key, { phase: "half_open", trial: false });
      } };
  } };
}

/** 배경 consumer 줄의 한 틱 안에서만 gateway 전송 결과·CLI 호출 결과를 그 줄의 회로에 알린다(capacity-consumer-scope 와 같은 범위 표시) */
const outcomeScope = new AsyncLocalStorage<(result: ProviderResult) => void>();
export function withProviderOutcome<T>(record: (result: ProviderResult) => void, run: () => Promise<T>): Promise<T> {
  return outcomeScope.run(record, run);
}
/** 배경 CLI 줄(소개 검수·Claude 감사)이 판정한 CLI 결과(PR06f). 범위 밖이면 아무것도 하지 않는다 */
export function reportProviderOutcome(result: ProviderResult): void {
  outcomeScope.getStore()?.(result);
}
/**
 * 전송 단계 결과(응답 상태·연결 실패·deadline). 범위 밖이면 같은 Promise 를 그대로 돌려준다 — 기존 호출 그대로다.
 * 200 뒤 본문을 읽다 끊긴 것은 여기서 보지 않는다(그 호출은 성공한 전송으로 센다).
 */
export function observeProviderTransport<T extends { status: number }>(response: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  const record = outcomeScope.getStore();
  if (!record) return response;
  return response.then(value => {
    const status = value.status;
    record(status === 200 ? { ok: true } : { ok: false, error: status === 404 ? "model_unavailable" : status === 429 ? "rate_limit"
      : status === 401 || status === 403 ? "auth" : `http_${status}` });
    return value;
  }, (error: unknown) => {
    // 호출한 쪽 중단은 provider 장애가 아니다. deadline(TimeoutError)만 timeout 으로 센다
    const reason: unknown = signal?.aborted ? signal.reason : null;
    record({ ok: false, error: !signal?.aborted ? "network" : reason instanceof Error && reason.name === "TimeoutError" ? "timeout" : "cancelled" });
    throw error;
  });
}
