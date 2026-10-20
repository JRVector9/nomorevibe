import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { queueWeeklyDigests, sendPendingEmails } from "@/lib/me/email-outbox";

/** 알림 메일 발송함을 비운다 — 발신 설정이 없으면 남은 줄을 skipped 로 닫고 네트워크를 부르지 않는다(lib/me/email-outbox.ts) */
export async function sendEmailOutbox(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const tick = await sendPendingEmails({ lease: ctx.lease, hasBudget: ctx.hasBudget, signal: ctx.signal });
  ctx.log("me.email_outbox_tick", tick);
  return { done: true, cursor: null };
}

/** 고른 요일·시각(KST)이 지난 계정마다 이번 주 요약 한 통을 발송함에 넣는다 */
export async function queueEmailDigests(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const tick = await queueWeeklyDigests({ lease: ctx.lease, hasBudget: ctx.hasBudget });
  ctx.log("me.email_digest_tick", tick);
  return { done: true, cursor: null };
}
