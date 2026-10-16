import { z } from "zod";

/**
 * abcLLM 게이트웨이 serving 계약 설정(ABCLLM_SERVING_CONTRACTS).
 *
 * 운영자가 배포 readback(게이트웨이 병합 SHA·컨테이너 파일 해시, 엔진 launch 인자와 상한 C, 모델 identity)으로 검증한 값만 넣는다.
 * 형식: {"version":1,"contracts":[<kind 계약 스키마 그대로>, ...]}, UTF-8 16KiB 이하(HOST_DB_BUDGET 과 같은 관례).
 * - 프로세스 시작 때 한 번 읽는다. 다시 읽는 경로는 없다 — 값을 바꾸려면 프로세스를 다시 띄운다.
 * - 없거나 JSON·최상위 모양이 틀리면 모든 kind 가 null(=deferred)이다. routeId 를 모르는 항목은 어느 kind 것인지 정할 수 없어
 *   설정 전체를 틀린 것으로 본다.
 * - kind 는 routeId 로 나눈다. 한 kind 의 항목이 하나라도 틀리거나 같은 model 이 두 번 나오면 그 kind 만 통째로 null 이다.
 *   다른 kind 는 자기 항목만으로 판정하므로 한 kind 의 오류가 다른 kind 를 열지 않는다.
 * - 계약 값이 바뀌면 각 kind 의 계약 hash 가 바뀌어, 앞 계약으로 묶은 binding(servingContractHash)과 맞지 않는다.
 */
export const GATEWAY_SERVING_CONTRACT_ROUTES = ["crawl-agent-review", "second-review", "product-search-profile", "crawl-tagline",
  "product-search-verify", "reason-translate", "product-translate", "product-tagline-ko", "search-query-translate"] as const;
export type GatewayServingRoute = typeof GATEWAY_SERVING_CONTRACT_ROUTES[number];
/** non-raw wire 로 보내는 번역 4경로. abcLLM PR1 의 raw terminal 이 닿지 않아 PR3 엄격 terminal opt-in 이 있어야만 연다. */
const STRICT_TERMINAL_ROUTES: readonly GatewayServingRoute[] = ["reason-translate", "product-translate", "product-tagline-ko", "search-query-translate"];
/** abcLLM PR3(JRVector9/abcLLM#3) 요청 헤더. 게이트웨이는 값이 정확히 "1" 일 때만 non-raw 비스트리밍을 엄격 terminal 로 돈다. */
export const ABCLLM_STRICT_TERMINAL_HEADER = "X-Abcllm-Strict-Terminal";
/**
 * 번역 4경로 계약의 strictTerminalOptIn 표시. 이 표시가 있는 계약의 native 호출만 위 헤더를 붙인다.
 * 헤더는 본문 밖이라 wireHash 에 들지 않는다 — 대신 표시가 계약 hash 에 들어가 binding 이 opt-in 여부를 묶는다.
 */
export const ABCLLM_STRICT_TERMINAL_OPT_IN = "abcllm-strict-terminal-v1";

const MAX_CONFIG_BYTES = 16 * 1024;
const configSchema = z.object({ version: z.literal(1),
  contracts: z.array(z.looseObject({ routeId: z.enum(GATEWAY_SERVING_CONTRACT_ROUTES) })) }).strict();
type ServingContract = { routeId: string; model: string; strictTerminalOptIn?: string };

/** 순수 해석: 설정 문자열에서 한 kind 의 model 별 계약을 읽는다. 없거나 그 kind 가 틀리면 빈 Map 이다. */
export function gatewayServingContractsFromConfig<T extends ServingContract>(raw: string | undefined, routeId: GatewayServingRoute,
  schema: z.ZodType<T>): ReadonlyMap<string, Readonly<T>> {
  const none = new Map<string, Readonly<T>>();
  if (raw === undefined || Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) return none;
  let entries: unknown[];
  try { entries = configSchema.parse(JSON.parse(raw)).contracts.filter(entry => entry.routeId === routeId); } catch { return none; }
  const contracts = new Map<string, Readonly<T>>();
  for (const entry of entries) {
    let parsed: z.ZodSafeParseResult<T>;
    // 일부 계약 스키마의 endpoint 검사는 잘못된 URL 에서 던진다 — 던져도 그 kind 만 닫는다
    try { parsed = schema.safeParse(entry); } catch { return none; }
    if (!parsed.success || parsed.data.routeId !== routeId || contracts.has(parsed.data.model)
      || STRICT_TERMINAL_ROUTES.includes(routeId) && parsed.data.strictTerminalOptIn !== ABCLLM_STRICT_TERMINAL_OPT_IN) return none;
    contracts.set(parsed.data.model, Object.freeze(parsed.data));
  }
  return contracts;
}

const STARTUP_CONFIG = process.env.ABCLLM_SERVING_CONTRACTS;
/** 각 계약 모듈이 자기 모듈을 처음 읽을 때 한 번 부른다. 재적재 함수는 두지 않는다. */
export function startupGatewayServingContracts<T extends ServingContract>(routeId: GatewayServingRoute,
  schema: z.ZodType<T>): ReadonlyMap<string, Readonly<T>> {
  return gatewayServingContractsFromConfig(STARTUP_CONFIG, routeId, schema);
}
