import { z } from "zod";
import { servingContractSnapshot } from "./serving-contract-store";

/**
 * 모델 serving 계약의 route 목록·검사·live 보기.
 *
 * 계약은 관리 화면이 저장한 model_serving_contracts 행(0147)만 쓴다. 운영자가 readback(엔진 launch 인자와 상한 C, 모델 identity)으로
 * 검증한 값만 넣는다. 예전의 시작 env 계약은 2026-10-31 abcLLM 게이트웨이 정리 때 지웠다 — 이제 어떤 env 도 계약을 열지 않는다.
 * - 한 행의 검사가 틀리면 그 route·model 만 닫힌다(null = deferred). 다른 행·다른 route 는 자기 행만으로 판정한다.
 * - 계약 값이 바뀌면 각 kind 의 계약 hash 가 바뀌어, 앞 계약으로 묶은 binding(servingContractHash)과 맞지 않는다.
 */
export const GATEWAY_SERVING_CONTRACT_ROUTES = ["crawl-agent-review", "second-review", "product-search-profile", "crawl-tagline",
  "product-search-verify", "reason-translate", "product-translate", "product-tagline-ko", "search-query-translate", "crawl-publish-classify"] as const;
export type GatewayServingRoute = typeof GATEWAY_SERVING_CONTRACT_ROUTES[number];
/**
 * non-raw wire 로 보내는 번역 4경로. abcLLM PR1 의 raw terminal 이 닿지 않아 PR3 엄격 terminal opt-in 이 있어야만 연다.
 * 게이트웨이가 없는 엔진 직접 계약(provider local-direct, direct-openai-chat-v1 — PR 3b-E)은 엔진의 완결 응답 자체가 terminal 이라 이 표시가 없다.
 */
const STRICT_TERMINAL_ROUTES: readonly GatewayServingRoute[] = ["reason-translate", "product-translate", "product-tagline-ko", "search-query-translate"];
const strictTerminalMissing = (routeId: GatewayServingRoute, contract: ServingContract): boolean =>
  STRICT_TERMINAL_ROUTES.includes(routeId) && contract.provider !== "local-direct" && contract.strictTerminalOptIn !== ABCLLM_STRICT_TERMINAL_OPT_IN;
/** abcLLM PR3(JRVector9/abcLLM#3) 요청 헤더. 게이트웨이는 값이 정확히 "1" 일 때만 non-raw 비스트리밍을 엄격 terminal 로 돈다. */
export const ABCLLM_STRICT_TERMINAL_HEADER = "X-Abcllm-Strict-Terminal";
/**
 * 번역 4경로 계약의 strictTerminalOptIn 표시. 이 표시가 있는 계약의 native 호출만 위 헤더를 붙인다.
 * 헤더는 본문 밖이라 wireHash 에 들지 않는다 — 대신 표시가 계약 hash 에 들어가 binding 이 opt-in 여부를 묶는다.
 */
export const ABCLLM_STRICT_TERMINAL_OPT_IN = "abcllm-strict-terminal-v1";

type ServingContract = { routeId: string; model: string; provider?: string; strictTerminalOptIn?: string };

/** 한 항목만 검사한다(관리 화면 저장·DB 행). 틀리면 null 이다. */
export function parseGatewayServingContract<T extends ServingContract>(value: unknown, routeId: GatewayServingRoute, schema: z.ZodType<T>): Readonly<T> | null {
  let parsed: z.ZodSafeParseResult<T>;
  try { parsed = schema.safeParse(value); } catch { return null; }
  if (!parsed.success || parsed.data.routeId !== routeId || strictTerminalMissing(routeId, parsed.data)) return null;
  return Object.freeze(parsed.data);
}

/** 관리 화면 계약(model_serving_contracts)의 live 보기. 스냅샷이 바뀌면 다시 읽는다. 검사에 실패한 행은 그 model 만 닫는다. */
class LiveGatewayContracts<T extends ServingContract> implements ReadonlyMap<string, Readonly<T>> {
  private cache: { token: string; map: ReadonlyMap<string, Readonly<T>> } | null = null;
  constructor(private readonly routeId: GatewayServingRoute, private readonly schema: z.ZodType<T>) {}
  private current(): ReadonlyMap<string, Readonly<T>> {
    const snapshot = servingContractSnapshot();
    if (this.cache?.token === snapshot.token) return this.cache.map;
    const map = new Map<string, Readonly<T>>();
    for (const row of snapshot.rows) {
      if (row.routeId !== this.routeId) continue;
      const contract = parseGatewayServingContract(row.contract, this.routeId, this.schema);
      if (contract && contract.model === row.model) map.set(row.model, contract);
    }
    this.cache = { token: snapshot.token, map };
    return map;
  }
  get size() { return this.current().size; }
  get(model: string) { return this.current().get(model); }
  has(model: string) { return this.current().has(model); }
  forEach(callback: (value: Readonly<T>, key: string, map: ReadonlyMap<string, Readonly<T>>) => void, thisArg?: unknown) { this.current().forEach(callback, thisArg); }
  entries() { return this.current().entries(); }
  keys() { return this.current().keys(); }
  values() { return this.current().values(); }
  [Symbol.iterator]() { return this.current()[Symbol.iterator](); }
}

const ROUTE_SCHEMAS = new Map<GatewayServingRoute, z.ZodType<ServingContract>>();
const ROUTE_GATEWAY_SHAPES = new Map<GatewayServingRoute, z.ZodType<ServingContract>>();
/**
 * 각 계약 모듈이 자기 모듈을 처음 읽을 때 한 번 부른다. 관리 화면 계약이 스냅샷이 바뀔 때마다 반영된다.
 * schema 는 그 route 가 받는 모든 계약 모양이다. 엔진에 직접 보내는 direct-openai-chat-v1 계약도 받는 route(PR 3b-C: crawl-agent-review,
 * PR 3b-E: text 7경로)는 두 모양의 합을 넘기고 gatewayShape 에 게이트웨이 총량 상한(raw) 모양을 따로 적는다 — 엔진 연결이 채우는 칸은 그 모양이다.
 */
export function startupGatewayServingContracts<T extends ServingContract>(routeId: GatewayServingRoute,
  schema: z.ZodType<T>, options: { gatewayShape?: z.ZodType<ServingContract> } = {}): ReadonlyMap<string, Readonly<T>> {
  ROUTE_SCHEMAS.set(routeId, schema as z.ZodType<ServingContract>);
  ROUTE_GATEWAY_SHAPES.set(routeId, options.gatewayShape ?? schema as z.ZodType<ServingContract>);
  return new LiveGatewayContracts(routeId, schema);
}
/** 그 route 계약 모듈이 이미 읽힌 경우의 스키마(관리 화면 검사용 — direct 계약도 받는 route 는 둘 다 받는다). 모듈을 읽지 않았으면 null 이다. */
export function registeredGatewayServingContractSchema(routeId: GatewayServingRoute): z.ZodType<ServingContract> | null {
  return ROUTE_SCHEMAS.get(routeId) ?? null;
}
/** 그 route 의 게이트웨이 총량 상한(raw) 계약 모양(엔진 연결이 protocol·칸을 읽는다). 모듈을 읽지 않았으면 null 이다. */
export function registeredGatewayContractShape(routeId: GatewayServingRoute): z.ZodType<ServingContract> | null {
  return ROUTE_GATEWAY_SHAPES.get(routeId) ?? null;
}
