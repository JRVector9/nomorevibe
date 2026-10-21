import { createHash } from "node:crypto";
import { sharedStore } from "@/lib/cache/shared";
import type { HumanQueueOverview } from "@/lib/crawl/human-queue";
import { humanQueueOverview } from "@/lib/crawl/review-overview";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { sharedLoader } from "./shared-cache";

/**
 * 관리자 화면 여러 곳이 같이 읽는 무거운 수 — 웹 여러 대·열린 화면 여러 개가 Valkey 로 30초 나눠 쓴다(shared-cache.ts).
 *
 * 관리자 화면 전체가 스스로 다시 읽게 되면서(LiveBar) 오늘 할 일·운영센터·메뉴 배지가 저마다 사람 몫(reviewQueueAiDecisions 의
 * DISTINCT ON 포함)을 주 DB 에서 다시 셌다 — 창 하나에 분당 수백 건. 화면만 쓴다: 워커(human-review 잡)는 그대로 직접 센다.
 * 심사 큐 화면은 결정한 뒤 수가 곧바로 맞아야 해 여기를 거치지 않는다.
 */
const OVERVIEW_TTL_MS = 30_000;
const overviewCache = sharedLoader<HumanQueueOverview>({ namespace: "admin:human-queue-overview", ttlMs: OVERVIEW_TTL_MS, store: sharedStore });

/** 설정이 바뀌면 열쇠가 바뀐다 — 지난 설정으로 센 수를 쓰지 않는다 */
const settingsKey = (settings: CrawlSettings) => createHash("sha256").update(JSON.stringify(settings)).digest("hex").slice(0, 32);

export function sharedHumanQueueOverview(settings: CrawlSettings, fresh = false): Promise<HumanQueueOverview> {
  return overviewCache(settingsKey(settings), () => humanQueueOverview(settings), fresh);
}
