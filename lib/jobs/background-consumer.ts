import { requestJob } from "./control";
import { readModelCapacityCallerControl } from "@/lib/llm/capacity-repository";
import { withSlotOnlyModelCapacity } from "@/lib/llm/capacity-consumer-scope";
import type { BackgroundConsumerLanes } from "@/scripts/worker";

/**
 * 배경 모델 작업의 계속 소비(PR06c) — 정해진 job 만, 기본 비활성.
 *
 * 대상은 모든 모델 호출이 공통 슬롯(background class)을 거치는 job 이다: text 의 검색 키워드 짓기·검수, 사유·제품 번역,
 * 한국어 소개, 소개 짓기와 reviewer 의 소개 검수·Claude 감사. 제외: embedding(공통 슬롯 밖, PR16)·repo-review(모델 없음)·
 * Grok 세션 점검(4시간 keepalive, 일감 큐가 아니다)·1차/2차 심사(item consumer PR06a/b)·translation batch 역할(번역 실호출 1 을
 * batch admission 이 지킨다).
 *
 * 배경 dispatch 는 역할 lease·job lease 에 묶인다(binding 의 role·job). item lease 는 fetch/ai1/ai2 만 받으므로(0077 CHECK),
 * 같은 일감을 legacy 틱과 겹쳐 돌리지 않는 fence 는 기존 job lease 다. 그래서 consumer 는 역할 워커 안의 줄로 돈다.
 */
export const BACKGROUND_CONSUMER_JOBS = {
  text: ["product-search-profile", "product-search-verify", "reason-translate", "product-translate", "product-tagline-ko", "crawl-tagline"],
  reviewer: ["product-intro-check", "product-audit"],
} as const satisfies Record<string, readonly string[]>;

/**
 * 버전이 없으면 비활성(legacy 그대로). 켜면 이 역할의 고정 목록 안에서 하나 이상, 겹침 없이.
 * 주의(2026-10-21): product-audit 을 넣으면 공통 슬롯이 open 일 때만 돈다 — 감사 보류 쓸기·Qwen 직접 감사·Qwen-v2 자동 단계는 공통 슬롯을 쓰지 않으므로
 * slot 모드가 open 이 아니면 넣지 않는다(lib/crawl/jobs/product-audit.ts)
 */
export function backgroundConsumerJobs(role: string, env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const version = env.PIPELINE_BACKGROUND_CONSUMER_VERSION;
  if (version === undefined) return [];
  if (version !== "1") throw new Error("invalid_background_consumer_version");
  const allowed: readonly string[] = Object.hasOwn(BACKGROUND_CONSUMER_JOBS, role) ? BACKGROUND_CONSUMER_JOBS[role as keyof typeof BACKGROUND_CONSUMER_JOBS] : [];
  const names = (env.PIPELINE_BACKGROUND_CONSUMER_JOBS ?? "").split(",");
  if (!names.every(name => allowed.includes(name)) || new Set(names).size !== names.length) throw new Error("invalid_background_consumer_jobs");
  return names;
}

/** 실제 연결: 슬롯이 open 일 때만 잡고, 슬롯 밖 원 경로를 거절하는 범위에서 runJob 하며, 남은 일이 있으면 기존 requestJob 으로 다시 요청한다 */
export function backgroundConsumerLanes(names: readonly string[], run: BackgroundConsumerLanes["run"]): BackgroundConsumerLanes {
  return { names, open: async () => (await readModelCapacityCallerControl()).mode === "open",
    run: (name, options) => withSlotOnlyModelCapacity(() => run(name, options)), request: name => requestJob(name) };
}
