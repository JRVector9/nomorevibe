import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { pruneEmailOutbox, queueWeeklyDigests, sendPendingEmails } from "@/lib/me/email-outbox";

/**
 * 알림 메일 발송함을 비운다 — 이 프로세스에 발신 설정(LOGIN_EMAIL_*·PUBLIC_AUTH_SECRET)이 없으면 줄을 건드리지 않고
 * 기다리는 수만 경고한다. 네트워크도 부르지 않는다(lib/me/email-outbox.ts)
 */
export async function sendEmailOutbox(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const tick = await sendPendingEmails({ lease: ctx.lease, hasBudget: ctx.hasBudget, signal: ctx.signal });
  ctx.log("me.email_outbox_tick", tick);
  return { done: true, cursor: null };
}

/**
 * 발송함을 먼저 정리하고(하루 넘게 못 보낸 줄 닫기·30일 지난 닫힌 줄 지우기 — 발신 설정과 관계없이),
 * 고른 요일·시각(KST)이 지난 계정마다 이번 주 요약 한 통을 발송함에 넣는다(발신 설정이 있을 때만)
 */
export async function queueEmailDigests(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const pruned = await pruneEmailOutbox({ lease: ctx.lease, hasBudget: ctx.hasBudget });
  const tick = await queueWeeklyDigests({ lease: ctx.lease, hasBudget: ctx.hasBudget });
  ctx.log("me.email_digest_tick", { ...tick, ...pruned });
  return { done: true, cursor: null };
}
