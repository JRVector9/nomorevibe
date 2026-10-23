import { sharedStore } from "@/lib/cache/shared";
import { homeListSlugs, koreanTaglineQueue, type KoreanTaglineQueue } from "@/lib/domain/products/korean-taglines";
import { withDbDeadline } from "@/lib/db/pool";
import { logger } from "@/lib/observability/logger";
import { withDeadline } from "./deadline";
import { readReplicaOrHold, type ReplicaRead } from "./replica-hold";
import { sharedLoader } from "./shared-cache";

const queueCache = sharedLoader<KoreanTaglineQueue>({
  namespace: "admin:korean-translation-queue", ttlMs: 30_000, store: sharedStore,
});

/** 메뉴·상태 화면이 30초 공유. 작업과 같은 홈 목록/선택 조건으로 복제본에서만 센다. */
export function readKoreanTranslationQueue(): Promise<ReplicaRead<KoreanTaglineQueue>> {
  return withDeadline(withDbDeadline(Date.now() + 3_000, () =>
    readReplicaOrHold("operations.korean_translation_unavailable", () =>
      queueCache("current", async () => koreanTaglineQueue(await homeListSlugs())))), 3_000)
    .catch((error): ReplicaRead<KoreanTaglineQueue> => {
      logger.warn("operations.korean_translation_unavailable", { errorName: error instanceof Error ? error.name : "unknown" });
      return { ok: false, reason: "error" };
    });
}
