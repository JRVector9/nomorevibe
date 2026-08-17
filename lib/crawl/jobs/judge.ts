import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import type { CrawlDocument } from "@/lib/db/schema";
import { findByUrl } from "@/lib/domain/products/repository";
import * as crawl from "@/lib/crawl/repository";
import { getSettings } from "@/lib/crawl/settings";
import { judge, factsFromRepoMeta, type Verdict } from "@/lib/crawl/rules";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";

/**
 * 판정 잡 — 수집한 원본에 현재 기준을 적용해 후보로 남긴다.
 *
 * 규칙 자체는 순수 함수(rules.ts)다. 이 잡이 더 보는 것은 레포 메타만으로는 알 수 없는
 * 두 가지뿐이다: 그 URL이 이미 등록돼 있는지, 차단된 URL인지.
 *
 * 커서가 없다. 판정하면 후보 state가 바뀌어 대기 목록에서 빠지므로 큐 자체가 진행 지점이다.
 * 기준을 바꾼 뒤 후보 state를 new로 되돌리면 같은 원본이 다시 들어온다 — 원본을 보관하는
 * 이유가 그것이다.
 */

/** 한 번에 꺼내는 원본 수. 판정은 순수 계산이라 빠르고 DB 왕복이 비용이다 */
const BATCH = 50;

export async function judgeCrawlDocuments(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const settings = await getSettings();
  if (!settings.enabled) {
    // 수집을 끈 상태에서 판정만 도는 것은 의도가 아니다
    ctx.log("crawl.judge_skipped", { reason: "disabled" });
    return { done: true };
  }

  const counts: Record<string, number> = {};
  let judged = 0;

  while (ctx.hasBudget()) {
    const documents = await crawl.documentsAwaitingJudgement(BATCH);
    if (documents.length === 0) {
      ctx.log("crawl.judged", { judged, counts, drained: true });
      return { done: true };
    }

    for (const document of documents) {
      const verdict = await judgeDocument(document, settings);
      await crawl.recordJudgement({
        repo: document.repo,
        productUrl: document.productUrl,
        state: verdict.state,
        reason: verdict.reason,
        decidedBy: "auto",
        signals: verdict.signals,
      });
      counts[verdict.reason] = (counts[verdict.reason] ?? 0) + 1;
      judged++;
      if (!ctx.hasBudget()) break;
    }
  }

  // 예산이 끝났을 뿐 큐는 남아 있다 — 다음 틱이 이어받는다
  ctx.log("crawl.judged", { judged, counts, drained: false });
  return { done: false };
}

/**
 * 규칙 판정에 DB가 아는 사실을 얹는다.
 *
 * 규칙이 이미 거부한 것은 더 볼 필요가 없다 — 거부된 후보가 중복인지 아닌지는
 * 아무 의미가 없고, 조회는 후보 수만큼 늘어난다.
 */
async function judgeDocument(document: CrawlDocument, settings: CrawlSettings): Promise<Verdict> {
  const verdict = judge(
    factsFromRepoMeta(document.repo, document.repoMeta),
    { productUrl: document.productUrl, status: document.pageStatus },
    settings,
  );
  if (verdict.state === "rejected" || !document.productUrl) return verdict;

  const existing = await findByUrl(document.productUrl);
  if (!existing) return verdict;

  // 차단한 URL이 수집기를 통해 되돌아오는 것을 막는다. 차단은 재등록까지 막는 조치다.
  return {
    state: "rejected",
    reason: existing.status === "banned" ? "banned" : "already_listed",
    signals: { ...verdict.signals, existingSlug: existing.slug, existingStatus: existing.status },
  };
}
