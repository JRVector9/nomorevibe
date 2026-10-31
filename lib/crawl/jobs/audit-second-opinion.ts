import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { getSettings } from "@/lib/crawl/settings";
import { runQwenSecondOpinions } from "@/lib/crawl/audit-second-opinion-auto";

/**
 * 감사 두 번째 의견·공개분 2차 거르기 잡(audit-second-opinion) — Qwen-v2 자동 단계(lib/crawl/audit-second-opinion-auto.ts): 감사 거절에
 * gpu3090 Qwen-v2 의 두 번째 의견을 적고(autoClose 면 그 답으로 닫고), 공개분 2차의 사람 확인 행을 한 번 더 본다.
 * 2026-10-31(PR 3a-C) 전에는 감사 잡(product-audit) 틱 안에서 감사 묻기와 나란히 돌았다 — 감사 묻기가 끝나도 이 단계를 기다려 틱을 닫았고,
 * 게이트웨이 감사의 양보·Qwen 직접 감사의 서버 탈이 한 잡의 틱에 섞였다. 이제 자기 줄(audit-opinion)에서 돈다. 스위치는 qwenAuto.auditSecondOpinion·
 * publishedFilter(기본 꺼짐). 새 호출은 STEP_MS(30초) 안에서만, gpu3090 두 번째 자리(withQwenSecondarySlot)·함께 쓰는 물러나기는 그대로다.
 * 이 단계는 잡을 실패시키지 않는다(단계 안에서 잡아 관측에 남긴다).
 */
export async function reviewAuditSecondOpinions(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  if (!ctx.lease) throw new Error("audit_second_opinion_job_required");
  const settings = await getSettings();
  const tally = await runQwenSecondOpinions(ctx, settings);
  return { done: tally.audit.asked + tally.audit.caughtUp + tally.published.asked === 0 };
}
