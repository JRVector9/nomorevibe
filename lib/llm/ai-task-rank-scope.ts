import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 글 짓기·번역·검색 text 작업이 「작업 ↔ 모델」 순위 하나로 부르는 동안의 범위(2026-11-02 소유자 결정, PR B).
 *
 * 순위 하나(연결 + 모델)를 고른 쪽(lib/llm/ai-task-resolver.ts)이 이 범위를 열고, 그 안의 깊은 코드(장부 요청·계약 고르기·결과 기록)는
 * `textTaskModel(route)` 로 그 순위의 장부 이름(identity)을 읽는다. 예전의 `scopedModel(route, 환경변수 상수)` 자리다 — 범위 밖에서 부르면
 * 코드 기본값·환경변수로 떨어지지 않고 던진다(조용히 다른 모델로 부르지 않는다).
 *
 * identity 는 장부(model_capacity_requests.model)·정책 route·계약 행(model_serving_contracts.model)의 열쇠다. 보통은 엔진 모델 이름 그대로이고,
 * 같은 모델 이름을 다른 연결에도 둔 순위는 연결로 가른 이름(`<모델>@<연결 id 앞 8자>`)이다 — 엔진에는 engineModel 이 나간다(계약의 engineModel).
 * bearer 는 연결(ai_connections)에 저장한 키다 — 계약 행의 키가 아니라 연결의 키를 보낸다(serving-contract-store textRouteAccess 가 읽는다).
 *
 * 이 모듈은 아무것도 import 하지 않는다(계약 모듈·serving-contract-store 가 읽어도 순환이 생기지 않게).
 */
export type TextTaskRankBinding = Readonly<{
  /** 작업 id = text 경로 id(이 일곱 작업은 둘이 같다) */
  routeId: string;
  /** 1·2·3 */
  rank: number;
  connectionId: string;
  connectionLabel: string;
  /** 장부·정책 route·계약 행의 model 열쇠 */
  identity: string;
  /** 엔진에 보내는 모델 이름(순위 행의 model) */
  engineModel: string;
  /** 계약의 provider(장부의 provider) */
  provider: "abcllm" | "local-direct";
  /** Authorization 에 실을 연결의 키. null 이면 보내지 않는다 */
  bearer: string | null;
  /** 연결의 용량 장비 이름(정책 route 의 groupId) */
  deviceId: string;
}>;

type Store = ReadonlyMap<string, TextTaskRankBinding>;
const holder = globalThis as unknown as { __nmvTextTaskRankScope?: AsyncLocalStorage<Store> };
const scope = (): AsyncLocalStorage<Store> => (holder.__nmvTextTaskRankScope ??= new AsyncLocalStorage<Store>());

/** 순위 하나의 범위에서 run 을 돌린다. 다른 경로의 바깥 범위는 그대로 이어진다(경로마다 하나). */
export function runInTextTaskRank<T>(binding: TextTaskRankBinding, run: () => T): T {
  const outer = scope().getStore();
  const next = new Map(outer ?? []);
  next.set(binding.routeId, Object.freeze({ ...binding }));
  return scope().run(next, run);
}

/** 지금 범위에서 이 경로의 순위(없으면 null). */
export function activeTextTaskRank(routeId: string): TextTaskRankBinding | null {
  return scope().getStore()?.get(routeId) ?? null;
}

/** 순위 범위 밖에서 text 경로의 모델을 물었다 — 코드 기본값·환경변수로 떨어지지 않는다. */
export class TextTaskRankMissingError extends Error {
  constructor(readonly routeId: string) {
    super(`text_task_rank_missing:${routeId}`);
    this.name = "TextTaskRankMissingError";
  }
}

/** 지금 순위의 장부 이름(identity). 범위 밖이면 던진다. */
export function textTaskModel(routeId: string): string {
  const binding = activeTextTaskRank(routeId);
  if (!binding) throw new TextTaskRankMissingError(routeId);
  return binding.identity;
}
