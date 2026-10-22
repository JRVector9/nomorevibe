import { sql } from "drizzle-orm";
import { db, onReplica } from "@/lib/db";

/**
 * 메일이 정말 나가고 있나 — 알림 메일 발송함(email_outbox)과 로그인 코드 메일(email_login_challenges)의 최근 24시간.
 *
 * 전에는 어디서도 읽지 않았다. 발신 설정이 없으면 maintenance 가 경고 로그만 남기고, Resend 가 키·도메인·한도(401·403·429)로
 * 거절하면 미루기만 하다가 하루 뒤 "모름"·"건너뜀"으로 닫았다 — 받는 사람은 메일을 못 받고 운영센터는 조용했다.
 * 수만 센다(주소·제목·본문은 읽지 않는다). 로그인 챌린지는 만료 색인(expires_at = 만든 뒤 10분)으로 최근 24시간을 고른다.
 */
export type EmailHealth = {
  outbox: {
    /** 아직 보내지 못한 줄 · 그중 1시간 넘은 것 · 가장 오래된 것의 나이(분) */
    pending: number; pendingOverdue: number; oldestPendingMinutes: number | null;
    /**
     * 최근 48시간에 만든 줄 중 — 보냄 · 결과 모름(시도 소진·하루 지나 닫음 포함) · Resend 가 거절 · 한 번도 못 보내고 하루 지나 닫음.
     * 하루 지난 줄은 만든 지 24~48시간에 닫히므로 창을 48시간으로 둔다(24시간이면 막 닫힌 줄을 놓친다)
     */
    accepted: number; unknown: number; rejected: number; expired: number;
  };
  login: {
    /** 최근 24시간 로그인 코드 메일 — 전체 · 거절·결과 모름 */
    total24h: number; failed24h: number;
    /** 결과가 정해진 가장 최근 세 통의 결과(새것부터) — 셋 다 실패면 지금 메일 로그인이 막힌 것이다 */
    recent: ("accepted" | "rejected" | "unknown")[];
  };
};

const EMAIL_HEALTH_SQL = sql`
  SELECT
    (SELECT count(*)::int FROM email_outbox WHERE state = 'pending') AS pending,
    (SELECT count(*)::int FROM email_outbox WHERE state = 'pending' AND created_at < now() - interval '1 hour') AS pending_overdue,
    (SELECT floor(extract(epoch FROM now() - min(created_at)) / 60)::int FROM email_outbox WHERE state = 'pending') AS oldest_pending_minutes,
    (SELECT count(*)::int FROM email_outbox WHERE state = 'accepted' AND created_at > now() - interval '48 hours') AS accepted,
    (SELECT count(*)::int FROM email_outbox WHERE state = 'unknown' AND created_at > now() - interval '48 hours') AS unknown,
    (SELECT count(*)::int FROM email_outbox WHERE state = 'rejected' AND created_at > now() - interval '48 hours') AS rejected,
    (SELECT count(*)::int FROM email_outbox WHERE state = 'skipped' AND last_error = 'expired' AND created_at > now() - interval '48 hours') AS expired,
    (SELECT count(*)::int FROM email_login_challenges WHERE expires_at > now() - interval '23 hours 50 minutes') AS login_total,
    (SELECT count(*)::int FROM email_login_challenges WHERE expires_at > now() - interval '23 hours 50 minutes'
      AND delivery_state IN ('rejected', 'unknown')) AS login_failed,
    (SELECT coalesce(jsonb_agg(recent.delivery_state ORDER BY recent.created_at DESC), '[]'::jsonb) FROM (
      SELECT delivery_state, created_at FROM email_login_challenges
      WHERE expires_at > now() - interval '23 hours 50 minutes' AND delivery_state <> 'pending'
      ORDER BY created_at DESC LIMIT 3) recent) AS login_recent`;

const int = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : Number(value ?? 0) || 0;

export function readEmailHealthRow(row: Record<string, unknown> | undefined): EmailHealth {
  const recent = Array.isArray(row?.login_recent) ? row.login_recent.filter((state): state is EmailHealth["login"]["recent"][number] =>
    state === "accepted" || state === "rejected" || state === "unknown") : [];
  const oldest = row?.oldest_pending_minutes;
  return {
    outbox: { pending: int(row?.pending), pendingOverdue: int(row?.pending_overdue),
      oldestPendingMinutes: oldest === null || oldest === undefined ? null : int(oldest),
      accepted: int(row?.accepted), unknown: int(row?.unknown), rejected: int(row?.rejected), expired: int(row?.expired) },
    login: { total24h: int(row?.login_total), failed24h: int(row?.login_failed), recent },
  };
}

export async function emailHealth(): Promise<EmailHealth> {
  const rows = await onReplica(() => db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    return tx.execute<Record<string, unknown>>(EMAIL_HEALTH_SQL);
  }, { accessMode: "read only" }));
  return readEmailHealthRow(rows[0]);
}

/**
 * 조치할 일의 판정. 보류: 최근 이틀에 못 보내고 닫은 줄이 있거나(결과 모름·하루 지나 닫음 — Resend 거절은 그 메일 탓일 수 있어 세기만 한다)
 * 1시간 넘게 못 보낸 줄이 있다(정상이면 몇 분 안에 나간다 — 재시도 간격 1·5·15분, 미룸 5분). 긴급: 가장 오래 기다린 것이 4시간을 넘었거나
 * (하루가 지나면 보내지 않고 닫는다 — 보류 1시간의 4배), 셋 넘게 못 보냈는데 보낸 것이 하나도 없다(발송이 통째로 막혔다).
 * 로그인 코드 메일: 하루 안에 한 통이라도 거절·결과 모름이면 보류(코드 메일은 그 자리에서 보내 사람이 기다린다), 가장 최근 세 통이
 * 모두 실패면 긴급(지금 메일 로그인이 안 된다).
 */
export function emailOutboxLevel(health: EmailHealth["outbox"]): "hold" | "critical" | null {
  const undelivered = health.unknown + health.expired;
  if ((health.oldestPendingMinutes ?? 0) >= 240 || (undelivered >= 3 && health.accepted === 0)) return "critical";
  return undelivered > 0 || health.pendingOverdue > 0 ? "hold" : null;
}

export function loginEmailLevel(health: EmailHealth["login"]): "hold" | "critical" | null {
  if (health.recent.length >= 3 && health.recent.every((state) => state !== "accepted")) return "critical";
  return health.failed24h > 0 ? "hold" : null;
}
