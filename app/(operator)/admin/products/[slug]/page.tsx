import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { getEvidenceAdminProduct } from "@/lib/domain/evidence/admin";
import { getProductRefreshRequest } from "@/lib/domain/evidence/refresh-requests";
import { EVIDENCE_LABELS } from "@/lib/domain/evidence/provenance";
import { productHistory } from "@/lib/domain/products/history";
import { formatDetailTime } from "@/lib/format/time";
import { BanAction } from "../BanAction";
import { ForceRefreshForm, UpdateVisibilityForm } from "./EvidenceProductActions";
import { makerMembersOf } from "./MakerMembers";
import {
  DECLARATION_LABELS, EVIDENCE_AUDIT_LABELS, FACT_LABELS, HISTORY_KIND_LABELS, LINK_KIND_LABELS, PRODUCT_STATUS_LABELS,
  RELATIONSHIP_LABELS, SOURCE_STATE_LABELS, UPDATE_SOURCE_LABELS, historyActionLabel, historyNote, labelOf,
} from "./labels";
import { introEditorNotes } from "@/lib/domain/products/intro-editor";
import { categoryLabel } from "@/lib/domain/products/labels";
import { findBySlug } from "@/lib/domain/products/repository";
import { productTranslationAdminQueue } from "@/lib/domain/products/translation-admin";
import { claimInviteUrl } from "@/lib/domain/products/claim-invite";
import { siteOrigin } from "@/lib/site";
import { db } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import { takedownRequests, introCorrectionRequests } from "@/lib/db/schema";
import { PrototypePanel, PrototypeFacts, PrototypeTag, PrototypeEmpty, prototypeRepositoryStatus } from "../PrototypeParts";
import { PrototypeIntroForm, PrototypeClaimInvite } from "../PrototypeProductForms";
import { PageStamp } from "@/app/(operator)/admin/components/PageStamp";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "제품 근거 — NoMoreVibe", robots: { index: false } };

type Props = { params: Promise<{ slug: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> };

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

export default async function AdminEvidenceProductPage({ params, searchParams }: Props) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const { slug } = await params;
  const query = await searchParams ?? {};
  const sections = [["overview","개요"],["intro","소개·번역"],["evidence","출처·근거"],["maker","메이커"],["quality","품질"],["requests","관련 요청"],["updates","업데이트"],["history","변경 기록"]] as const;
  const section = typeof query.section === "string" && sections.some(([key]) => key === query.section) ? query.section : "overview";
  const [view, product] = await Promise.all([getEvidenceAdminProduct(slug), findBySlug(slug)]);
  if (!view || !product) notFound();
  const [refresh, history, makers] = await Promise.all([getProductRefreshRequest(slug).catch(() => null), productHistory(slug).catch(() => null), makerMembersOf(slug).catch(() => null)]);
  const translation = section === "intro" ? await productTranslationAdminQueue({ state: "all", q: slug, limit: 30 }).catch(() => null) : null;
  const introNotes = section === "intro" ? await introEditorNotes([product.id]).catch(() => null) : null;
  const requestData = section === "requests" ? await Promise.all([
    db.select({ at: takedownRequests.requestedAt, handled: takedownRequests.handledAt, outcome: takedownRequests.outcome, reason: takedownRequests.reason }).from(takedownRequests).where(eq(takedownRequests.slug, slug)),
    db.select({ at: introCorrectionRequests.createdAt, handled: introCorrectionRequests.handledAt }).from(introCorrectionRequests).where(eq(introCorrectionRequests.slug, slug)).orderBy(desc(introCorrectionRequests.createdAt)).limit(30),
  ]).catch(() => null) : null;
  const activityHref = `/admin/activity?target=${encodeURIComponent(slug)}`;
  const historyPanel = <PrototypePanel title="프로젝트 변경·감사 기록" actions={<Link className="text-button" href={activityHref}>전체 기록 →</Link>}>{history === null ? <PrototypeEmpty>기록을 읽지 못했습니다.</PrototypeEmpty> : history.length === 0 ? <PrototypeEmpty>남은 변경 기록이 없습니다.</PrototypeEmpty> : <ol className="timeline">{history.map((entry, index) => <li key={`${entry.kind}-${index}`}><time>{date(entry.at)}</time><div><b>{historyActionLabel(entry.kind, entry.action)}</b><p>{HISTORY_KIND_LABELS[entry.kind]} · {entry.actor ?? "자동 / 이전 기록"} · {entry.ok ? "완료" : "실패"}</p>{entry.note && <p>{historyNote(entry.kind, entry.action, entry.note)}</p>}</div></li>)}</ol>}</PrototypePanel>;
  const sourcePanel = <PrototypePanel title="외부 출처·선언 링크" actions={<ForceRefreshForm slug={slug} />}><div className="table-scroll"><table style={{ minWidth: 720 }}><thead><tr><th>출처</th><th>선언 / 관측</th><th>확인</th><th>관계</th></tr></thead><tbody>{view.links.map(link => <tr key={link.id}><td><Code labels={LINK_KIND_LABELS} code={link.kind} /></td><td><a href={link.url} target="_blank" rel="noopener noreferrer">{link.url}</a><p><Code labels={DECLARATION_LABELS} code={link.declarationSource} /></p></td><td><Code labels={SOURCE_STATE_LABELS} code={link.verificationState} /></td><td><Code labels={RELATIONSHIP_LABELS} code={link.relationshipState} /></td></tr>)}</tbody></table></div><div className="table-scroll mt"><table style={{ minWidth: 850 }}><thead><tr><th>관측 출처</th><th>상태 / 사실</th><th>최근 성공</th><th>다음 확인</th><th>실패</th></tr></thead><tbody>{view.sources.map(source => <tr key={source.id}><td><Code labels={LINK_KIND_LABELS} code={source.kind} /></td><td><Code labels={SOURCE_STATE_LABELS} code={source.state} /><p><FactList facts={source.facts} /></p></td><td>{date(source.lastSuccessAt)}</td><td>{date(source.nextAttemptAt)}</td><td>{source.lastErrorCode ?? "—"}<p>{date(source.lastFailureAt)} · {source.attempts}회</p></td></tr>)}</tbody></table></div>{view.links.length + view.sources.length === 0 && <PrototypeEmpty>아직 수집한 출처가 없습니다.</PrototypeEmpty>}</PrototypePanel>;
  return <main data-admin-detail="product"><PageStamp />
    <div className="page-heading"><div className="project-hero"><span className="project-avatar">{product.name.slice(0,2)}</span><div><div className="eyebrow">프로젝트 #{product.id} / {product.source === "crawler" ? "자동 수집" : "직접 등록"}</div><h1>{product.name}</h1><p>{product.url} · <Code labels={PRODUCT_STATUS_LABELS} code={product.status} /></p></div></div><div className="heading-actions"><Link className="button small" href="/admin/products">목록으로</Link><Link className="button" href={`/admin/products/${slug}?section=intro`}>소개·번역 관리</Link><BanAction slug={slug} name={product.name} banned={product.status === "banned"} className="button danger" /></div></div>
    <div className="flex mb"><PrototypeTag tone={product.status === "banned" ? "gray" : "green"}><Code labels={PRODUCT_STATUS_LABELS} code={product.status} /></PrototypeTag><PrototypeTag>메이커 {makers === null ? "확인 못함" : makers.some(row => !row.revokedAt) ? "확인 기록 있음" : "미확인"}</PrototypeTag><PrototypeTag tone={view.conflicts.length ? "amber" : "gray"}>{view.conflicts.length ? `선언 충돌 ${view.conflicts.length}건` : "확인된 선언 충돌 없음"}</PrototypeTag></div>
    <nav className="tabs" aria-label="프로젝트 상세">{sections.map(([id,label]) => <Link key={id} href={`/admin/products/${slug}?section=${id}`} aria-current={section === id ? "page" : undefined}>{label}</Link>)}</nav>
    {section === "overview" && <><div className="grid split"><PrototypePanel title="프로젝트 정보" actions={<ForceRefreshForm slug={slug} />}><PrototypeFacts rows={[["현재 소개",product.tagline || "아직 소개 없음"],["카테고리",categoryLabel(product.category)],["공개 상태",<Code key="status" labels={PRODUCT_STATUS_LABELS} code={product.status} />],["소유권 확인",makers === null ? "확인 못함" : makers.some(row => !row.revokedAt) ? "현재 확인된 운영자 있음 · 노출과 별도" : "현재 확인된 운영자 없음"],["사이트",<a key="url" href={product.url} target="_blank" rel="noopener noreferrer">{product.url}</a>]]} /></PrototypePanel><PrototypePanel title="공개 카드 미리보기"><div className="project-preview"><div className="preview-window"><div className="flex"><span className="project-avatar">{product.name.slice(0,2)}</span><h3>{product.name}</h3></div><p className="small muted mt">{product.tagline || "소개가 등록되지 않았습니다."}</p><div className="flex mt"><PrototypeTag>{categoryLabel(product.category)}</PrototypeTag><PrototypeTag>{product.accessMode === "website" ? "웹 서비스" : "설치·실행형"}</PrototypeTag></div></div><p className="small muted mt-sm">현재 원본으로 구성한 카드 · 실제 노출은 공개 조건에 따릅니다.</p><a className="text-button" href={`/p/${slug}`} target="_blank" rel="noopener noreferrer">공개 화면 확인 ↗</a></div></PrototypePanel></div><div className="mt">{historyPanel}</div></>}
    {section === "intro" && <div className="stack"><PrototypePanel title="현재 소개·출처와 언어별 상태"><div className="grid two"><div><div className="field"><label>현재 공개 소개</label><div className="evidence-box">{product.tagline || "비어 있음"}</div><p>소개 출처 {({maker:"메이커 입력",ai_page:"사이트 기반 AI 소개",ai_readme:"문서 기반 AI 소개",ai_both:"사이트·문서 기반 AI 소개",ai_fixed:"근거로 보완한 AI 소개",editor:"운영자 편집"})[product.taglineSource]}</p></div><details className="mt"><summary className="text-button">소개 편집</summary>{introNotes?.has(product.id) ? <PrototypeIntroForm slug={slug} tagline={product.tagline} /> : <div className="notice">현재 소개 편집 검토 대상이 아닙니다. 메이커의 원문 수정 권한과 운영자 소개 확인 처리는 구분합니다.</div>}</details></div><div><h4>언어별 후처리</h4>{translation === null ? <PrototypeEmpty>언어별 상태를 읽지 못했습니다.</PrototypeEmpty> : <ul className="list-rows">{translation.items.filter(row => row.slug === slug).map(row => <li key={`${row.locale}-${row.field}`}><div className="main"><b>{row.locale} · {row.field}</b><p>{row.sourceMatches ? "현재 원문과 일치" : "원문 변경됨"} · {formatDetailTime(row.updatedAt)}</p></div><PrototypeTag tone={row.status === "failed" ? "red" : row.status === "pending" ? "amber" : "green"}>{({pending:"대기",ready:"저장됨",reviewed:"검토값 저장됨",failed:"실패"})[row.status]}</PrototypeTag></li>)}{translation.items.filter(row => row.slug === slug).length === 0 && <li>저장된 언어별 수요가 없습니다.</li>}</ul>}</div></div><div className="decision-bar"><Link className="button" href={`/admin/translations?q=${encodeURIComponent(slug)}`}>원문·번역 대조 및 실패 재요청</Link></div></PrototypePanel></div>}
    {section === "evidence" && <div className="stack">{sourcePanel}{refresh && <PrototypePanel title="근거 갱신 진행"><PrototypeFacts rows={[["요청 / 완료",`#${refresh.requestedVersion} / #${refresh.completedVersion}`],["처리한 출처",refresh.progress.completedKeys.length],["최근 완료",date(refresh.completedAt)],["다음 시도",date(refresh.nextAttemptAt)],["최근 오류",refresh.lastError ?? "없음"]]} /></PrototypePanel>}<PrototypePanel title="내부 미디어·빌드 출처"><div className="grid two"><div><h4>선언 / 복사본</h4><ul className="list-rows">{view.declarations.map(item => <li key={item.id}><div className="main"><b>선언 rev {item.revision}</b><p>{item.sourceUrl}</p></div></li>)}{view.media.map(item => <li key={item.id}><div className="main"><b>복사본 v{item.version} · {item.current ? "현재" : "이전"}</b><p>{item.sourceUrl}</p></div><PrototypeTag tone={item.visible ? "green" : "gray"}>{item.visible ? "표시" : "숨김"}</PrototypeTag></li>)}</ul></div><div><h4>에이전트 / 스킬</h4><ul className="list-rows">{view.agents.map(agent => <li key={agent.id}><div className="main"><b>{agent.provider}</b><p>{agent.roles.join(", ")} · {EVIDENCE_LABELS[agent.evidenceLevel]}</p></div></li>)}{view.skills.map(skill => <li key={skill.id}><div className="main"><b>{skill.namespace}/{skill.name}</b><p>{EVIDENCE_LABELS[skill.evidenceLevel]}</p></div></li>)}</ul></div></div>{view.conflicts.length > 0 && <div className="notice amber mt"><b>라이선스 충돌</b>{view.conflicts.map(c => <p key={c.field}>메이커 {c.makerValue} · 관측 {c.observedValue}</p>)}</div>}</PrototypePanel></div>}
    {section === "maker" && <PrototypePanel title="운영자 확인·클레임">{makers === null ? <PrototypeEmpty>운영자 확인을 읽지 못했습니다.</PrototypeEmpty> : makers.length === 0 ? <PrototypeEmpty>현재 확인된 운영자 기록이 없습니다.</PrototypeEmpty> : <div className="table-scroll"><table><thead><tr><th>운영자</th><th>확인 방식</th><th>확인 / 재확인</th><th>상태</th></tr></thead><tbody>{makers.map(row => <tr key={row.userId}><td>{row.displayName}<p>{row.role === "owner" ? "운영자" : "편집자"}</p></td><td>{({ github_repo_owner:"GitHub 저장소 주인",github_repo_admin:"GitHub 저장소 관리자",repo_file:"저장소 확인 파일",edit_token:"수정 키",admin:"관리자 확인" })[row.method] ?? "확인 방식 상세"}</td><td>{date(row.verifiedAt)}<p>{date(row.recheckAt)}</p></td><td><PrototypeTag tone={row.revokedAt ? "gray" : "green"}>{row.revokedAt ? "해제됨" : "확인됨"}</PrototypeTag><p>{row.revokedReason}</p></td></tr>)}</tbody></table></div>}<div className="mt"><PrototypeClaimInvite slug={slug} inviteUrl={claimInviteUrl(product, siteOrigin())} invitedAt={product.claimInvitedAt ? date(product.claimInvitedAt) : null} /></div></PrototypePanel>}
    {section === "quality" && <PrototypePanel title="이 프로젝트의 품질·검사"><PrototypeFacts rows={[["공개 상태",<Code key="status" labels={PRODUCT_STATUS_LABELS} code={product.status} />],["저장소 상태",prototypeRepositoryStatus(product.repoStatus)],["저장소 확인",date(product.repoCheckedAt)],["확인된 선언 충돌",view.conflicts.length],["검사 종류","AI 감사 / 공개분 2차 / 규칙 / 저장소·생존"]]} /><div className="decision-bar"><Link className="button" href={`/admin/audit?q=${encodeURIComponent(slug)}`}>감사 근거·유지·내림 결정</Link><Link className="button" href="/admin/products?tab=quality">전체 품질 큐</Link><Link className="button" href="/admin/products/recheck">규칙 재검수</Link></div></PrototypePanel>}
    {section === "requests" && <PrototypePanel title="연결된 사용자 요청">{requestData === null ? <PrototypeEmpty>요청 기록을 읽지 못했습니다.</PrototypeEmpty> : <div className="table-scroll"><table><thead><tr><th>요청</th><th>원본 상태</th><th>접수</th><th>처리 장소</th></tr></thead><tbody>{requestData[0].map((row,i) => <tr key={`down-${i}`}><td>내림 요청<p>{row.reason}</p></td><td>{row.handled ? row.outcome ?? "처리됨" : "처리 대기"}</td><td>{date(row.at)}</td><td><Link className="button small" href="/admin/requests?tab=correction">요청함에서 처리</Link></td></tr>)}{requestData[1].map((row,i) => <tr key={`intro-${i}`}><td>소개 수정 요청</td><td>{row.handled ? "처리됨" : "처리 대기"}</td><td>{date(row.at)}</td><td><Link className="button small" href="/admin/requests?tab=correction">요청함에서 처리</Link></td></tr>)}</tbody></table>{requestData[0].length + requestData[1].length === 0 && <PrototypeEmpty>연결된 내림·소개 수정 요청 기록이 없습니다.</PrototypeEmpty>}</div>}</PrototypePanel>}
    {section === "updates" && <PrototypePanel title="업데이트"><div className="table-scroll"><table><thead><tr><th>출처</th><th>업데이트</th><th>노출</th><th>관리</th></tr></thead><tbody>{view.updates.map(update => <tr key={update.id}><td><Code labels={UPDATE_SOURCE_LABELS} code={update.sourceKind} /></td><td>{update.title}</td><td><PrototypeTag tone={update.visible ? "green" : "gray"}>{update.visible ? "표시" : "숨김"}</PrototypeTag></td><td>{update.sourceKind === "maker" ? "메이커 API 관리" : <UpdateVisibilityForm slug={slug} updateId={update.id} visible={update.visible} />}</td></tr>)}</tbody></table>{view.updates.length === 0 && <PrototypeEmpty>등록된 업데이트가 없습니다.</PrototypeEmpty>}</div></PrototypePanel>}
    {section === "history" && <div className="stack">{historyPanel}<PrototypePanel title="근거 감사 기록"><ul className="timeline">{view.audits.map(audit => <li key={audit.id}><time>{date(audit.createdAt)}</time><div><b><Code labels={EVIDENCE_AUDIT_LABELS} code={audit.action} /></b><p>{audit.actor} · {audit.reason ?? "사유 없음"}</p></div></li>)}</ul></PrototypePanel></div>}
  </main>;
}
