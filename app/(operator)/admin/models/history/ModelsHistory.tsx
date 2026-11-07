import Link from "next/link";
import type { AdminModelsObservation } from "@/lib/operations/admin-models-observation";
import { LevelBadge } from "../LlmOpsParts";
import { MODEL_REQUEST_REVIEW_HREF, ModelCallsPanel } from "../ModelCallsPanel";

/** 기존 변경 기록 — 각 화면의 #audit 와 작업 로그. 한 표로 합치는 것은 다음 단계(PR 3)다. */
const AUDIT_LINKS = [
  { href: "/admin/activity?group=llm", label: "작업 로그 · LLM 운영", note: "누가 무엇을 바꿨는지 전체" },
  { href: "/admin/models/tasks#audit", label: "연결·순위 변경", note: "연결 저장·모델 다시 읽기·순위·가져오기" },
  { href: "/admin/models/devices#audit", label: "장비 한도 저장", note: "동시 실행 한도·역할 순서" },
  { href: "/admin/models/limits#audit", label: "실시간 한도 저장", note: "경로 한도·기한·묶음·틱 예산" },
  { href: "/admin/models/helpers#audit", label: "도우미 장비", note: "감시자·도우미 모드·자동 정지" },
  { href: "/admin/models/assignments#audit", label: "모델 배정", note: "배정 표 저장·끄기" },
] as const;

export function ModelsHistory({ observation }: { observation: AdminModelsObservation }) {
  const readable = !observation.error && !!observation.observedAt;
  const retry = readable ? observation.rows.reduce((total, row) => total + row.indeterminate, 0) : null;
  return <div className="stack llm-ops" data-llm-page="history">
    <section className="llm-panel" id="retry" aria-labelledby="llm-retry-title">
      <div className="llm-panel-head"><h2 id="llm-retry-title">재실행 대기</h2>
        <LevelBadge level={retry === null ? "unknown" : retry > 0 ? "warn" : "ok"}>{retry === null ? "확인 불가" : `결과 미확정 ${retry.toLocaleString("ko-KR")}건`}</LevelBadge></div>
      <div className="llm-panel-body">
        <p className="llm-empty">결과 미확정은 칸을 차지하지 않습니다. 근거를 본 뒤 다시 대기열에 넣거나 닫는 곳은 지금 고급 설정의 「확인 못함 · 사람 검토」입니다(다음 단계에서 이 화면으로 옮깁니다).</p>
        <p><Link prefetch={false} className="button small" href={MODEL_REQUEST_REVIEW_HREF}>다시 대기열·닫기 열기 →</Link></p>
      </div>
    </section>
    <ModelCallsPanel observation={observation} limit={30} />
    <section className="llm-panel" aria-labelledby="llm-audit-title">
      <div className="llm-panel-head"><h2 id="llm-audit-title">설정·조치 변경 기록</h2></div>
      <div className="llm-panel-body">
        <ul className="llm-todos">{AUDIT_LINKS.map(link => <li key={link.href} className="llm-todo">
          <div className="llm-todo-main"><p className="llm-todo-title">{link.label}</p><p className="llm-todo-detail">{link.note}</p></div>
          <Link prefetch={false} className="button small" href={link.href}>열기 →</Link></li>)}</ul>
      </div>
    </section>
  </div>;
}
