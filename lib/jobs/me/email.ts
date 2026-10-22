import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { pruneEmailOutbox, queueWeeklyDigests, sendPendingEmails, type OutboxTick } from "@/lib/me/email-outbox";

const EMAIL_BLOCKED: Record<NonNullable<OutboxTick["blocked"]>, (tick: OutboxTick) => string> = {
  sender_unconfigured: (tick) => `maintenance 에 발신 설정(LOGIN_EMAIL_API_KEY·LOGIN_EMAIL_FROM·PUBLIC_AUTH_SECRET)이 없어 ${tick.waiting}통이 기다립니다`,
  provider_unavailable: () => "Resend 가 키·도메인·한도로 거절해 미뤘습니다",
  compose_failed: () => "메일 글을 짓지 못해 미뤘습니다",
};

/**
 * 알림 메일 발송함을 비운다 — 이 프로세스에 발신 설정(LOGIN_EMAIL_*·PUBLIC_AUTH_SECRET)이 없으면 줄을 건드리지 않고
 * 기다리는 수만 경고한다. 네트워크도 부르지 않는다(lib/me/email-outbox.ts)
 */
export async function sendEmailOutbox(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const tick = await sendPendingEmails({ lease: ctx.lease, hasBudget: ctx.hasBudget, signal: ctx.signal });
  const { blocked, ...counts } = tick;
  ctx.log("me.email_outbox_tick", counts);
  // 보내지 못한 틱은 성공이 아니다 — 까닭을 러너에 넘겨 운영센터(알림 메일 조치)가 보이게 한다
  if (blocked) return { done: true, cursor: null, degraded: { code: blocked, detail: EMAIL_BLOCKED[blocked](tick) } };
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
