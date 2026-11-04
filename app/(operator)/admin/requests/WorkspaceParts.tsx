import type { ReactNode } from "react";
import Link from "next/link";
import { formatDetailTime } from "@/lib/format/time";
import { readCorrectionRequests, readRegistrationWorkspace, readRequestHistory, readRequestOverview } from "@/lib/operations/admin-request-workspace";
import { REQUEST_HISTORY_LABELS } from "@/lib/operations/admin-request-workspace-model";
import { IntroRequestList, TakedownQueue } from "../audit/TakedownQueue";

export function ReadUnavailable({ title }: { title: string }) {
  return <p className="rw-unavailable" role="status">{title}을(를) 불러오지 못했습니다. 0건이 아닙니다. 현재 상태를 다시 확인하세요.</p>;
}
function Panel({ title, note, children, id }: { title: string; note?: string; children: ReactNode; id?: string }) {
  return <section className="rw-panel" id={id}><header className="rw-panel-head"><h2>{title}</h2>{note && <span className="rw-meta">{note}</span>}</header><div className="rw-panel-body">{children}</div></section>;
}
const makerMethods: Record<string, string> = { github_repo_owner: "GitHub 저장소 주인", github_repo_admin: "GitHub 저장소 관리자", repo_file: "저장소 확인 파일", edit_token: "수정 키", admin: "관리자 확인" };
const time = (value: string | Date | null) => value ? formatDetailTime(value instanceof Date ? value : new Date(value)) : "확인 안 됨";

export async function OpenRequestsPanel({ fresh }: { fresh: boolean }) {
  const overview = await readRequestOverview(fresh);
  return <div className="rw-stack">
    <div className="rw-summary" role="status"><div><b>열린 사용자 요청 {overview.failed === overview.sections.length ? <span>확인 불가</span> : <><span>{overview.knownCount.toLocaleString("ko-KR")}</span>건{overview.failed > 0 ? " 이상" : ""}</>}</b><p>요청 유형별로 기다리는 일을 확인하고 원본을 검토하세요.</p></div>
      <span className="rw-meta">{overview.observedAt ? `${time(overview.observedAt)} 집계` : "요청 집계 시각 확인 불가"}</span></div>
    {overview.failed > 0 && <p className="rw-unavailable" role="status">{overview.failed}개 유형의 조회를 완료하지 못했습니다. 표시된 합계는 확인된 요청만 포함합니다.</p>}
    <div className="rw-card-grid">{overview.sections.map(section => <section className="rw-panel" key={section.key}>
      <header className="rw-panel-head"><h2>{section.title}</h2><span className={`rw-state${section.overdue ? " is-late" : ""}`}>{section.count === null ? "확인 불가" : `${section.count.toLocaleString("ko-KR")}건`}</span></header>
      <div className="rw-panel-body"><p className="rw-meta">{section.note}</p>{section.overdue ? <p className="rw-late">24시간 넘음 {section.overdue.toLocaleString("ko-KR")}건</p> : null}
        {section.count === null ? <ReadUnavailable title={section.title} /> : section.items.length ? <ul className="rw-preview">{section.items.map(item => <li key={item.id}><b>{item.name}</b><p>{item.why}</p><small>{time(item.since)}</small></li>)}</ul> : <p className="rw-empty compact">기다리는 요청이 없습니다.</p>}
        <Link href={section.href} prefetch={false} className="rw-button">{section.action} →</Link>
      </div>
    </section>)}</div>
  </div>;
}

export async function CorrectionRequestsPanel() {
  const { takedowns, intros } = await readCorrectionRequests();
  return <div className="rw-stack">
    <section id="takedowns" className="rw-stack"><div className="rw-section-line"><h2>내려달라는 요청</h2>{takedowns.ok && <span className="rw-meta">대기 {takedowns.data.summary.pending.toLocaleString("ko-KR")}건 · 24시간 넘음 {takedowns.data.summary.overdue.toLocaleString("ko-KR")}건</span>}</div>
      {!takedowns.ok ? <ReadUnavailable title="내림 요청" /> : takedowns.data.items.length ? <TakedownQueue entries={takedowns.data.items} /> : <p className="rw-empty">기다리는 내림 요청이 없습니다.</p>}
      {takedowns.ok && takedowns.data.summary.pending > takedowns.data.items.length && <Link href="/admin/audit?tab=requests" className="rw-meta underline">내림 요청 {takedowns.data.summary.pending.toLocaleString("ko-KR")}건 중 오래된 {takedowns.data.items.length}건 표시 · 기존 요청 화면</Link>}
    </section>
    <section id="intro-requests" className="rw-stack"><div className="rw-section-line"><h2>소개 수정 요청</h2>{intros.ok && <span className="rw-meta">대기 {intros.data.count.toLocaleString("ko-KR")}건</span>}</div>
      {!intros.ok ? <ReadUnavailable title="소개 수정 요청" /> : intros.data.items.length ? <IntroRequestList entries={intros.data.items} /> : <p className="rw-empty">기다리는 소개 수정 요청이 없습니다.</p>}
      {intros.ok && intros.data.count > intros.data.items.length && <p className="rw-meta">오래된 {intros.data.items.length}건을 표시합니다. 요청 처리 뒤 다음 자동 갱신에서 나머지를 확인할 수 있습니다.</p>}
    </section>
  </div>;
}

export async function RegistrationPanel() {
  const { pending, makerChecks } = await readRegistrationWorkspace();
  return <div className="rw-stack">
    <div className="rw-note">도메인 소유권과 GitHub 메이커 권한은 자동으로 확인합니다. 검증이 끝나지 않은 등록과 최근 메이커 확인 상태를 살펴보세요. 개별 상황은 프로젝트 상세에서 확인할 수 있습니다.</div>
    <Panel title="등록 · 도메인 검증 대기" note={pending.ok ? `${pending.data.count.toLocaleString("ko-KR")}건 · 오래된 25건까지 표시` : undefined}>
      {!pending.ok ? <ReadUnavailable title="등록·검증 상태" /> : !pending.data.items.length ? <p className="rw-empty compact">검증 대기 상태의 등록 프로젝트가 없습니다.</p> : <div className="rw-table-scroll"><table><thead><tr><th>프로젝트</th><th>등록 경로</th><th>현재 상태</th><th>등록 시각</th><th>확인</th></tr></thead><tbody>{pending.data.items.map(item => <tr key={item.id}><td><b>{item.name}</b><p>/{item.slug}</p></td><td>{item.source === "skill" ? "직접 등록" : item.source}</td><td><span className="rw-state">도메인 검증 대기</span><p>자동 검증 · 승인 개입 없음</p></td><td>{time(item.createdAt)}</td><td><Link href={`/admin/products/${item.slug}`} className="rw-button">프로젝트 상세</Link></td></tr>)}</tbody></table></div>}
    </Panel>
    <Panel title="메이커 확인 기록" note="최근 확인 25건 · 계정 연락처·수정 키는 표시하지 않음">
      {!makerChecks.ok ? <ReadUnavailable title="메이커 확인 기록" /> : !makerChecks.data.length ? <p className="rw-empty compact">메이커 확인 기록이 없습니다.</p> : <div className="rw-table-scroll"><table><thead><tr><th>프로젝트</th><th>확인 방식</th><th>현재 확인</th><th>확인·다음 재확인</th><th>상세</th></tr></thead><tbody>{makerChecks.data.map((item, index) => <tr key={`${item.productId}-${item.verifiedAt.toISOString()}-${index}`}><td><b>{item.name}</b><p>역할 {item.role === "owner" ? "소유자" : "편집자"}</p></td><td>{makerMethods[item.method] ?? item.method}</td><td><span className="rw-state">{item.revokedAt ? "확인 해제" : "확인됨"}</span>{item.revokedReason && <p>{item.revokedReason}</p>}</td><td>{time(item.verifiedAt)}<p>다음 재확인 {item.recheckAt ? time(item.recheckAt) : "미기록"}</p></td><td><Link href={`/admin/products/${item.slug}`} className="rw-button">메이커·출처 보기</Link></td></tr>)}</tbody></table></div>}
    </Panel>
    <Link href="/admin/requests?tab=contact" className="rw-button rw-next">인증 관련 문의 처리</Link>
  </div>;
}

export async function RequestHistoryPanel() {
  const result = await readRequestHistory();
  return <div className="rw-stack"><div className="rw-toolbar"><span className="rw-meta">원본 감사 기록의 최근 100개 접수·처리 동작 · 실패한 처리도 별도 표시</span><Link href="/admin/activity" className="rw-button">전체 운영 기록</Link></div>
    <Panel title="요청 접수·처리 기록">
      {!result.ok ? <ReadUnavailable title="요청 처리 기록" /> : !result.data.length ? <p className="rw-empty compact">기록된 요청 접수·처리 동작이 없습니다.</p> : <div className="rw-table-scroll"><table><thead><tr><th>시각</th><th>동작</th><th>대상</th><th>처리자</th><th>결과·근거</th></tr></thead><tbody>{result.data.map(item => <tr key={item.id}><td>{time(item.at)}</td><td>{REQUEST_HISTORY_LABELS[item.action] ?? item.action}</td><td className="rw-target">{item.target}</td><td>{item.actor}</td><td><span className={`rw-state${item.ok ? "" : " is-late"}`}>{item.ok ? "기록됨" : "실패·거절"}</span><p><Link href={`/admin/activity?target=${encodeURIComponent(item.target)}`}>감사 기록 #{item.id}</Link></p></td></tr>)}</tbody></table></div>}
    </Panel></div>;
}
