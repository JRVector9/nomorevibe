import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import type { CrawlDocument } from "@/lib/db/schema";
import { findByUrl } from "@/lib/domain/products/repository";
import * as crawl from "@/lib/crawl/repository";
import { getSettings } from "@/lib/crawl/settings";
import { judge, factsFromRepoMeta, pageFactsFromDocument, type Verdict } from "@/lib/crawl/rules";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { loadAgentJudgeInput } from "@/lib/crawl/agent-evidence";
import { requestJob } from "@/lib/jobs/control";

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
    const queue = await crawl.judgementQueue(BATCH);
    if (queue.length === 0) {
      ctx.log("crawl.judged", { judged, counts, drained: true });
      return { done: true };
    }

    let approved = 0;
    try {
      for (const { document, candidate } of queue) {
        const verdict = await judgeDocument(document, settings);
        if (!await crawl.recordAutomaticJudgement({document,settings,candidate,verdict})) {
          ctx.log("crawl.judgement_changed", {repo:document.repo});
          return {done:false};
        }
        counts[verdict.reason] = (counts[verdict.reason] ?? 0) + 1;
        judged++;
        if (verdict.state === "approved") approved++;
        if (!ctx.hasBudget()) break;
      }
    } finally {
      /**
       * 승인이 발행까지 스케줄(5분)을 기다리지 않게 한다. 묶음이 끝날 때 한 번만 부른다 —
       * 후보마다 부르면 잡 행 하나를 두고 경합한다. 승인이 없으면 부르지 않는다.
       */
      if (approved > 0) await requestJob("crawl-publish");
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
  const agentEvidence = settings.agentEvidence.enforceEligibility
    ? await loadAgentJudgeInput(document, settings) : undefined;
  const verdict = judge(
    factsFromRepoMeta(document.repo, document.repoMeta),
    pageFactsFromDocument(document),
    settings,
    new Date(),
    agentEvidence,
  );
  if (agentEvidence) verdict.signals.agentScanId = agentEvidence.scanId;
  if (verdict.state === "rejected" || !document.productUrl) return verdict;

  const existing = await findByUrl(document.productUrl);
  if (!existing) return verdict;

  // 차단한 URL이 수집기를 통해 되돌아오는 것을 막는다. 차단은 재등록까지 막는 조치다.
  // 규칙이 아니라 DB가 아는 사실이라 규칙 발자국 뒤에 따로 붙인다.
  return {
    state: "rejected",
    reason: existing.status === "banned" ? "banned" : "already_listed",
    signals: { ...verdict.signals, existingSlug: existing.slug, existingStatus: existing.status },
    trace: [...verdict.trace, {
      rule: existing.status === "banned" ? "차단된 URL 아님" : "이미 등록된 URL 아님",
      detail: `같은 URL이 /p/${existing.slug} 로 ${existing.status === "banned" ? "차단" : "등재"}되어 있음`,
      passed: false,
    }],
  };
}
