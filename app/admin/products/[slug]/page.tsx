import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { getEvidenceAdminProduct } from "@/lib/domain/evidence/admin";
import { getProductRefreshRequest } from "@/lib/domain/evidence/refresh-requests";
import { EVIDENCE_LABELS } from "@/lib/domain/evidence/provenance";
import { productHistory } from "@/lib/domain/products/history";
import { formatDetailTime } from "@/lib/format/time";
import { Panel } from "@/components/Panel";
import { ScrollTable } from "../../components/ScrollTable";
import { BanAction } from "../BanAction";
import { ForceRefreshForm, UpdateVisibilityForm } from "./EvidenceProductActions";
import {
  DECLARATION_LABELS, EVIDENCE_AUDIT_LABELS, FACT_LABELS, HISTORY_KIND_LABELS, LINK_KIND_LABELS, PRODUCT_STATUS_LABELS,
  RELATIONSHIP_LABELS, SOURCE_STATE_LABELS, UPDATE_SOURCE_LABELS, historyActionLabel, historyNote, labelOf,
} from "./labels";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "제품 근거 — NoMoreVibe", robots: { index: false } };

type Props = { params: Promise<{ slug: string }> };

/** 상세 시각 "2026-10-08 13:38:13 KST"(lib/format/time) */
const date = (value: Date | null) => formatDetailTime(value);

/** 상태값 — 한국어로 보이고 원래 코드는 툴팁으로(2026-10-08 UX 감사 ADM-28) */
function Code({ labels, code }: { labels: Record<string, string>; code: string | null | undefined }) {
  return <span title={code ?? undefined}>{labelOf(labels, code)}</span>;
}

/** 관측 사실 한 개의 값 — 시각은 상세 시각으로, 관계는 라벨로 */
function factValue(key: string, value: string | number): string {
  if (key === "pushedAt") return formatDetailTime(String(value), String(value));
  if (key === "relationship") return labelOf(RELATIONSHIP_LABELS, String(value));
  return typeof value === "number" ? value.toLocaleString("ko-KR") : value;
}

function FactList({ facts }: { facts: Awaited<ReturnType<typeof getEvidenceAdminProduct>> extends infer View
  ? View extends { sources: Array<{ facts: infer Facts }> } ? Facts : never
  : never }) {
  const entries = facts ? Object.entries(facts).filter((entry): entry is [string, string | number] => entry[1] !== null) : [];
  if (entries.length === 0) return <>관측 사실 없음</>;
  return entries.map(([key, value], index) => (
    <span key={key} title={`${key}=${value}`}>{index > 0 && " · "}{labelOf(FACT_LABELS, key)} {factValue(key, value)}</span>
  ));
}

export default async function AdminEvidenceProductPage({ params }: Props) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const { slug } = await params;
  const view = await getEvidenceAdminProduct(slug);
  if (!view) notFound();
  const [refresh, history] = await Promise.all([
    getProductRefreshRequest(slug),
    // 기록을 못 읽어도 상세는 그린다
    productHistory(view.product.slug).catch(() => null),
  ]);
  const refreshPending = refresh && refresh.requestedVersion > refresh.completedVersion;
  const activityHref = `/admin/activity?target=${encodeURIComponent(view.product.slug)}`;

  return (
    <main className="mx-auto max-w-[980px] px-4 pb-20 sm:px-6">
      <div className="flex flex-wrap items-baseline gap-3 pt-6">
        <h1 className="min-w-0 break-words text-[22px] font-extrabold tracking-tight">{view.product.name}</h1>
        <span className="font-mono text-[13px] text-fg-3">{view.product.slug}</span>
        <span className="text-[13px] font-semibold text-fg-2"><Code labels={PRODUCT_STATUS_LABELS} code={view.product.status} /></span>
        {/* 목록 ⋯ 메뉴와 같은 차단 — 사유를 고르고, 끝나면 알림에 되돌리기(2026-10-08 UX 감사 ADM-20) */}
        <span className="ml-auto">
          <BanAction slug={view.product.slug} name={view.product.name} banned={view.product.status === "banned"}
            className={`rounded-lg border px-3 py-1.5 text-[13px] font-semibold hover:bg-bg-hover disabled:opacity-50 ${
              view.product.status === "banned" ? "border-line text-fg-2" : "border-down/40 text-down"}`} />
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-[13px]">
        <a href={view.product.url} target="_blank" rel="noreferrer noopener" className="min-w-0 break-all text-accent hover:underline">
          {view.product.url}
        </a>
        <a href={`/p/${view.product.slug}`} target="_blank" rel="noreferrer noopener" className="font-semibold text-fg-2 hover:text-fg">
          공개 화면
        </a>
      </div>
      <div className="mt-5"><ForceRefreshForm slug={view.product.slug} /></div>
      {refresh && (
        <div className="mt-3 rounded-[10px] border border-line p-3 text-[13px]" aria-live="polite">
          <strong>{refreshPending ? (refresh.activeVersion ? "갱신 진행 중" : "갱신 예약됨") : "갱신 완료"}</strong>
          <span className="ml-3 text-fg-2">요청 #{refresh.requestedVersion} · 완료 #{refresh.completedVersion}</span>
          {refreshPending && <p className="mt-1 text-fg-2">출처 {refresh.progress.completedKeys.length}개 처리 · 다음 확인 {date(refresh.nextAttemptAt)}</p>}
          {refresh.completedAt && <p className="mt-1 text-fg-2">최근 완료 {date(refresh.completedAt)}</p>}
          {refresh.lastError && <p className="mt-1 text-down">{refresh.lastError}</p>}
          <a href={`/admin/products/${slug}`} className="mt-2 inline-block text-accent hover:underline">진행 상태 새로고침</a>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-4">
        <Panel title="이 제품의 기록" note="관리자 작업 로그, 후보 심사, 발행분 감사, 저장소 확인, 차단·해제를 최근 것부터 합쳐 봅니다."
          actions={<Link href={activityHref} prefetch={false} className="ml-auto text-[13px] font-semibold text-accent hover:underline">모두 보기</Link>}>
          {history === null ? <p className="mt-2 text-[13px] text-down">기록을 읽지 못했습니다.</p>
            : history.length === 0 ? <p className="mt-2 text-[13px] text-fg-3">남은 기록이 없습니다.</p> : (
            <ol className="mt-2 space-y-1.5 text-[13px]">{history.map((entry, index) => {
              const note = historyNote(entry.kind, entry.action, entry.note);
              return (
                <li key={`${entry.kind}-${entry.at.getTime()}-${index}`} className="grid gap-x-3 rounded-[10px] bg-bg-soft px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <span className="min-w-0 break-words">
                    <span className="text-fg-3">{HISTORY_KIND_LABELS[entry.kind]}</span>{" · "}
                    <strong title={entry.action}>{historyActionLabel(entry.kind, entry.action)}</strong>
                    {!entry.ok && <span className="font-semibold text-down"> · 실패</span>}
                    {entry.actor && <span className="text-fg-2"> · {entry.actor}</span>}
                    {note && <span className="text-fg-2"> · {note}</span>}
                  </span>
                  <time className="font-mono text-fg-3" dateTime={entry.at.toISOString()}>{formatDetailTime(entry.at)}</time>
                </li>
              );
            })}</ol>
          )}
        </Panel>

        <Panel title="메이커와 관측값 충돌" note="메이커 제공값을 숨기지 않고 객관적 출처의 값과 나란히 봅니다.">
          {view.conflicts.length === 0 ? (
            <p className="text-[13px] text-fg-3">확인된 충돌이 없습니다.</p>
          ) : view.conflicts.map((conflict) => (
            <div key={conflict.field} className="rounded-[10px] border border-down/30 bg-down/5 p-3 text-[13px]">
              <strong>라이선스 충돌</strong>
              <span className="ml-3 text-fg-2">메이커 {conflict.makerValue} · 관측 {conflict.observedValue}</span>
            </div>
          ))}
        </Panel>

        <Panel title="선언 링크" note="메이커 선언과 확인된 연결 상태를 분리합니다.">
          <ScrollTable label="선언 링크">
            <table className="w-full min-w-[680px] text-[13px]">
              <thead className="text-left text-fg-3"><tr><th className="pb-2">종류</th><th>선언</th><th>확인</th><th>관계</th><th>URL</th></tr></thead>
              <tbody>{view.links.map((link) => (
                <tr key={link.id} className="border-t border-line">
                  <td className="py-2"><Code labels={LINK_KIND_LABELS} code={link.kind} /></td>
                  <td><Code labels={DECLARATION_LABELS} code={link.declarationSource} /></td>
                  <td><Code labels={SOURCE_STATE_LABELS} code={link.verificationState} /></td>
                  <td><Code labels={RELATIONSHIP_LABELS} code={link.relationshipState} /></td><td className="max-w-[360px] truncate">{link.url}</td>
                </tr>
              ))}</tbody>
            </table>
          </ScrollTable>
        </Panel>

        <Panel title="외부 출처 상태" note="원문 응답 대신 정규화한 사실과 안전한 실패 코드만 표시합니다.">
          {view.sources.length === 0 ? <p className="text-[13px] text-fg-3">아직 수집한 출처가 없습니다.</p> : (
            <ScrollTable label="외부 출처 상태"><table className="w-full min-w-[820px] text-[13px]">
              <thead className="text-left text-fg-3"><tr><th className="pb-2">출처</th><th>상태</th><th>마지막 성공</th><th>마지막 실패</th><th>다음 시도</th><th>시도</th><th>오류</th></tr></thead>
              <tbody>{view.sources.map((source) => (
                <tr key={source.id} className="border-t border-line align-top">
                  <td className="py-2"><strong><Code labels={LINK_KIND_LABELS} code={source.kind} /></strong><p className="mt-1 text-fg-3"><FactList facts={source.facts} /></p></td>
                  <td><Code labels={SOURCE_STATE_LABELS} code={source.state} /></td><td>{date(source.lastSuccessAt)}</td><td>{date(source.lastFailureAt)}</td>
                  <td>{date(source.nextAttemptAt)}</td><td>{source.attempts}</td><td>{source.lastErrorCode ?? "—"}</td>
                </tr>
              ))}</tbody>
            </table></ScrollTable>
          )}
        </Panel>

        <Panel title="내부 미디어" note="외부 URL 선언과 내부 복사본 버전을 함께 봅니다.">
          <div className="grid gap-3 md:grid-cols-2">
            <div><h3 className="text-[13px] font-bold">수집 선언</h3><ul className="mt-2 space-y-2 text-[13px]">
              {view.declarations.map((item) => <li key={item.id} className="break-all rounded-[10px] bg-bg-soft p-3">#{item.position + 1} · rev {item.revision}<br />{item.sourceUrl}</li>)}
            </ul></div>
            <div><h3 className="text-[13px] font-bold">복사본 버전</h3><ul className="mt-2 space-y-2 text-[13px]">
              {view.media.map((item) => <li key={item.id} className="break-all rounded-[10px] bg-bg-soft p-3">v{item.version} · {item.current ? "현재" : "이전"} · {item.visible ? "표시" : "숨김"}{item.missingAt ? " · 원본 누락" : ""}<br />{item.sourceUrl}</li>)}
            </ul></div>
          </div>
        </Panel>

        <Panel title="업데이트" note="자동 감지 항목만 관리자가 숨기고 복원합니다. 메이커 항목은 메이커 API가 관리합니다.">
          <ul className="space-y-3 text-[13px]">{view.updates.map((update) => (
            <li key={update.id} className="rounded-[10px] border border-line p-3">
              <div className="flex flex-wrap gap-2"><strong>{update.title}</strong><span className="text-fg-3"><Code labels={UPDATE_SOURCE_LABELS} code={update.sourceKind} /> · {update.visible ? "표시" : "숨김"}</span></div>
              {update.sourceKind !== "maker" && <UpdateVisibilityForm slug={view.product.slug} updateId={update.id} visible={update.visible} />}
            </li>
          ))}</ul>
        </Panel>

        <Panel title="빌드 출처" note="표시된 근거 수준은 작성 주체와 증명 강도를 구분합니다.">
          <div className="grid gap-4 md:grid-cols-2 text-[13px]">
            <div><h3 className="font-bold">에이전트</h3><ul className="mt-2 space-y-1">{view.agents.map((agent) => <li key={agent.id}>{agent.provider} · {agent.roles.join(", ")} · <Code labels={EVIDENCE_LABELS} code={agent.evidenceLevel} /></li>)}</ul></div>
            <div><h3 className="font-bold">스킬</h3><ul className="mt-2 space-y-1">{view.skills.map((skill) => <li key={skill.id}>{skill.namespace}/{skill.name} · <Code labels={EVIDENCE_LABELS} code={skill.evidenceLevel} /></li>)}</ul></div>
          </div>
        </Panel>

        <Panel title="감사 기록" note="이력은 수정하거나 지우지 않고 새 행으로 추가합니다.">
          <ul className="space-y-2 text-[13px]">{view.audits.map((audit) => (
            <li key={audit.id} className="grid gap-1 rounded-[10px] bg-bg-soft p-3 sm:grid-cols-[1fr_auto]">
              <span className="min-w-0 break-words"><strong><Code labels={EVIDENCE_AUDIT_LABELS} code={audit.action} /></strong> · {audit.actor}{audit.reason ? ` · ${historyNote("status", audit.action, audit.reason)}` : ""}</span>
              <time className="font-mono text-fg-3">{date(audit.createdAt)}</time>
            </li>
          ))}</ul>
        </Panel>
      </div>
    </main>
  );
}
