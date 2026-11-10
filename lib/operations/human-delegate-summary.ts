import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, onReplica } from "@/lib/db";
import { sharedStore } from "@/lib/cache/shared";
import { getSettings } from "@/lib/crawl/settings";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { readDelegateGroups } from "@/lib/crawl/delegate-groups-read";
import { delegateGroupCounts, type DelegateGroup } from "@/lib/crawl/delegate-groups";
import { sharedLoader } from "./shared-cache";
import { sharedHumanQueueOverview } from "./shared-reads";

export type HumanDelegateSummary = { counts: Record<DelegateGroup, number> };

/** 흐름 화면은 15초마다 다시 읽는다 — 보류 전체를 훑는 갈래 읽기는 웹들이 30초 나눠 쓴다(사람 몫 구간 집계와 같은 수명) */
const summaryCache = sharedLoader<HumanDelegateSummary>({ namespace: "admin:human-delegate-summary", ttlMs: 30_000, store: sharedStore });
const settingsKey = (settings: CrawlSettings) => createHash("sha256").update(JSON.stringify(settings)).digest("hex").slice(0, 32);

/**
 * 운영 홈 「사람이 처리할 일」의 AI 위임 결과 수 — 근거 부족·확신 부족(delegate-groups.ts).
 * 수는 심사 목록 /admin/review?tab=human&delegate=… 의 전체 수와 같게 센다: 사람 몫(직접 판단 + 확정 필요) 안에서만.
 * 사람 몫 구간은 흐름 판이 이미 읽은 공유 집계(30초)를, 갈래는 복제본 한 번(5초 상한)을 읽는다 — 흐름 화면을 막지 않게 page.tsx 가 Suspense 로 흘린다.
 */
export async function readHumanDelegateSummary(fresh = false): Promise<HumanDelegateSummary> {
  const settings = await getSettings();
  return summaryCache(settingsKey(settings), async () => {
    const [overview, groups] = await Promise.all([
      sharedHumanQueueOverview(settings, fresh),
      onReplica(() => db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
        await tx.execute(sql`SET LOCAL jit = off`);
        return readDelegateGroups(settings, tx);
      }, { accessMode: "read only", isolationLevel: "repeatable read" })),
    ]);
    return { counts: delegateGroupCounts(groups, [...overview.ids.human, ...overview.ids.agreed]) };
  }, fresh);
}
