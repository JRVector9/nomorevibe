import { sql, type SQL } from "drizzle-orm";

/**
 * 원본 다시 받기(audit-stale-recollect.ts, 0188)를 감사 화면 항목 한 줄로 — 감사 목록(product-audit.ts findingColumns)이 읽는다.
 * 이 모듈은 DB 쓰기·수집 모듈을 끌어오지 않는다(감사 목록 → 다시 받기 → 감사 입력의 고리를 만들지 않게).
 */

export type AuditRecollectFailure = "no_source" | "repo_deleted" | "repo_empty" | "repo_renamed" | "source_refresh_failed"
  | "refetch_not_received_48h" | "refetch_expired_before_ask" | "input_error";

/**
 * 실패 사유의 짧은 이름 — 감사 화면의 상태 줄·항목 줄. 모두 '다시 받지 못해서'다 — 근거가 오래돼서 사람 몫이 되는 사유는 없다
 * (2026-11-17 사람 지시 "기간 상관없이 다시 살펴보고 진행중인 프로젝트인지 보게").
 */
export const AUDIT_RECOLLECT_FAILURE_SHORT: Readonly<Record<AuditRecollectFailure, string>> = {
  no_source: "원본 없음", repo_deleted: "저장소 없음(404)", repo_empty: "빈 저장소", repo_renamed: "이름 바뀜", source_refresh_failed: "수집 실패",
  refetch_not_received_48h: "48시간 안에 못 받음", refetch_expired_before_ask: "받은 뒤 묻지 못함(3번)", input_error: "입력 오류",
};

export type AuditRecollectView = {
  state: "waiting" | "done" | "failed" | "dropped";
  failureCode: string | null;
  /** 감사 때와 지금의 차이(사람이 읽는 글) — done 일 때만 */
  summary: string[] | null;
  sourceChanged: boolean | null;
  /** 요청한 날·끝난 날(YYYY-MM-DD, UTC) */
  requestedOn: string;
  settledOn: string | null;
};

/** 항목 하나의 다시 받기 줄(없으면 null) — 감사 목록의 칸. item 은 product_audit_items.id 를 가리키는 식 */
export function auditRecollectField(item: SQL): SQL<AuditRecollectView | null> {
  return sql<AuditRecollectView | null>`(select jsonb_build_object('state', r.state, 'failureCode', r.failure_code, 'summary', r.change_summary,
      'sourceChanged', r.source_changed, 'requestedOn', to_char(r.requested_at, 'YYYY-MM-DD'), 'settledOn', to_char(r.settled_at, 'YYYY-MM-DD'))
    from product_audit_recollects r where r.item_id = ${item})`;
}

const shortDay = (value: string | null) => {
  if (!value) return "";
  const [, m, d] = value.split("-");
  return `${Number(m)}/${d}`;
};

export type AuditRecollectLine = { label: string; text: string; warn: boolean };

/**
 * 감사 화면 항목의 한 줄 — 끝남: "감사 때 → 지금  사이트 404 → 200 · 마지막 push 9/02 → 11/10", 받는 중·사람 몫은 그 상태.
 * 사람 몫의 글은 늘 '다시 받지 못해서'임을 적는다(근거 나이로 사람 몫이 되는 길은 없다). dropped 는 보이지 않는다(사람이 이미 정함)
 */
export function auditRecollectLine(view: AuditRecollectView | null | undefined): AuditRecollectLine | null {
  if (!view || view.state === "dropped") return null;
  if (view.state === "waiting") {
    return { label: "원본 다시 받는 중", text: `${shortDay(view.requestedOn)} 요청 — 받으면 지금 근거로 두 번째 의견을 묻습니다`, warn: false };
  }
  if (view.state === "failed") {
    const reason = AUDIT_RECOLLECT_FAILURE_SHORT[view.failureCode as AuditRecollectFailure] ?? view.failureCode ?? "원인 미상";
    return { label: "다시 받지 못함", text: `${reason} — 사람 몫(근거 나이 때문이 아니라 다시 받지 못해서)`, warn: true };
  }
  const changes = view.summary?.filter(Boolean) ?? [];
  return { label: "감사 때 → 지금", text: changes.length ? changes.join(" · ")
    : `바뀐 것 없음(${shortDay(view.settledOn ?? view.requestedOn)} 다시 받아 확인)`, warn: false };
}
