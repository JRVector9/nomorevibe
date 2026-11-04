import { createHmac } from "node:crypto";
import Link from "next/link";
import { readRequestWorkspaceQueues, type RequestKind, type WorkspaceRequest } from "@/lib/operations/admin-request-workspace";
import { adminRequestToken } from "@/lib/operations/admin-requests-csrf";
import { contactLabels } from "@/lib/operations/admin-requests-contract";
import { formatWait } from "@/lib/domain/products/takedown-view";
import { formatDetailTime } from "@/lib/format/time";
import { FeedbackItem } from "@/components/product-detail/FeedbackList";
import { FeedbackReviewForm } from "../feedback/FeedbackReviewForm";
import { ReactionReviewForm } from "../reactions/ReactionReviewForm";
import { reactionAdminCsrf } from "../reactions/csrf";
import { ContactUpdateForm, MakerReplyReviewForm } from "./RequestForms";
import { PrototypeIntroAction, PrototypeTakedownAction } from "./PrototypeRequestActions";

type Props = { tab: "open" | "correction" | "contact" | "posts"; params: Record<string, string | string[] | undefined>; admin: { login: string; exp: number }; secret: string };
const names: Record<RequestKind, string> = { takedown: "내림 요청", intro: "소개 수정", contact: "문의", feedback: "피드백", replies: "메이커 답장", reactions: "써봤어요" };
const one = (value: string | string[] | undefined) => typeof value === "string" ? value : "";
export async function PrototypeRequestWorkspace({ tab, params, admin, secret }: Props) {
  const allowed: RequestKind[] = tab === "correction" ? ["takedown", "intro"] : tab === "contact" ? ["contact"] : tab === "posts" ? ["feedback", "replies", "reactions"] : ["takedown", "intro", "contact", "feedback", "replies", "reactions"];
  const kind = allowed.includes(one(params.kind) as RequestKind) ? one(params.kind) as RequestKind : "";
  const q = one(params.q).trim().slice(0, 120);
  const state = tab === "posts" ? kind === "reactions" ? "held" : ["held", "accepted", "rejected", "all"].includes(one(params.state)) ? one(params.state) : "held"
    : ["open", "all", ...Object.keys(contactLabels)].includes(one(params.state)) ? one(params.state) : "open";
  const rawOffset = Number(one(params.offset)), offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? Math.min(rawOffset, 100000) : 0;
  const sources = (kind ? [kind] : allowed).filter(value => !(tab === "posts" && !kind && ["accepted", "rejected"].includes(state) && value === "reactions"));
  const queues = await readRequestWorkspaceQueues(sources, state, offset, one(params.cursor) || undefined);
  const rows = queues.items.filter(item => !q || [item.name, item.type, item.body, item.key].some(value => value.toLocaleLowerCase().includes(q.toLocaleLowerCase())));
  const id = one(params.id), selected = id ? rows.find(item => item.key === id || item.key === `${item.kind}:${id}`) : rows[0];
  const query = (patch: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams(); const values = { tab, kind: kind || undefined, state: params.state ? state : undefined, q: q || undefined, offset: offset || undefined, cursor: one(params.cursor) || undefined, ...patch };
    for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") search.set(key, String(value)); return `/admin/requests?${search}`;
  };
  const takedown = queues.results.find(source => source.kind === "takedown")?.result;
  return <div className="stack">
    {takedown?.ok && takedown.data.count > 0 && <div className="callout"><div><h3>24시간 처리 약속이 있는 내림 요청을 먼저 확인하세요.</h3><p>일반 문의·소개 수정의 대기 시간과 내림 요청의 약속 기한을 구분합니다.</p></div><span className={`tag ${takedown.data.overdue ? "red" : "amber"}`}>{takedown.data.overdue ? `기한 초과 ${takedown.data.overdue}건` : `내림 요청 ${takedown.data.count}건`}</span></div>}
    <form action="/admin/requests" className="toolbar"><input type="hidden" name="tab" value={tab} /><input className="search-input" name="q" type="search" aria-label="요청 검색" defaultValue={q} maxLength={120} placeholder="프로젝트·요청 유형 검색 후 Enter" />
      {allowed.length > 1 && <select name="kind" defaultValue={kind} aria-label="요청 유형"><option value="">유형 전체</option>{allowed.map(value => <option value={value} key={value}>{names[value]}</option>)}</select>}
      {tab === "contact" && <select name="state" defaultValue={state} aria-label="문의 상태"><option value="open">열린 문의</option><option value="all">전체</option>{Object.entries(contactLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>}
      {tab === "posts" && kind !== "reactions" && <select name="state" defaultValue={state} aria-label="글 공개 상태"><option value="held">보류</option><option value="accepted">공개</option><option value="rejected">숨김</option><option value="all">전체</option></select>}<button className="button">조회</button><span className="small muted">기한 있는 요청 → 오래된 순</span><span className="spacer small muted">{queues.failed.length === queues.results.length ? "전체 수 —" : `${queues.count.toLocaleString("ko-KR")}건${queues.failed.length ? " 이상" : ""}`} · 현재 {rows.length}건</span>
    </form>
    {queues.failed.length > 0 && <div className="notice amber" role="status">{queues.failed.map(value => names[value]).join(" · ")} 조회 실패 · 이 유형의 현재 상태와 건수는 알 수 없습니다.</div>}
    {tab === "posts" && <div className="notice blue">피드백·메이커 답장의 공개·숨김·복원은 원본 상태에 반영됩니다. 써봤어요는 자동 검사가 보류한 한 줄만 조회합니다.</div>}
    <div className="grid detail"><section className="panel"><div className="table-scroll" tabIndex={0} role="region" aria-label="요청 목록"><table style={{ minWidth: 570 }}><thead><tr><th>{tab === "posts" ? "유형·프로젝트" : "요청·프로젝트"}</th><th>현재 상태</th><th>{tab === "posts" ? "원문" : "대기·기한"}</th><th>다음 행동</th></tr></thead><tbody>{rows.map(item => <tr className={selected?.key === item.key ? "selected" : undefined} key={item.key}><td><Link className="text-button name" scroll={false} prefetch={false} href={query({ id: item.key })}>{item.name}</Link><p className="request-type">{item.key} · {item.type}</p></td><td><span className={`tag ${item.status === "공개" || item.status === "해결" ? "green" : "amber"}`}>{item.status}</span></td><td>{tab === "posts" ? <span className="request-excerpt">{item.body.slice(0, 100)}{item.body.length > 100 ? "…" : ""}</span> : <>{formatWait(item.waitHours)}{item.kind === "takedown" && <p><span className={`tag ${item.waitHours >= 24 ? "red" : "amber"}`}>{item.waitHours >= 24 ? "24시간 초과" : `24시간까지 ${formatWait(Math.max(0, 24 - item.waitHours))}`}</span></p>}</>}</td><td><Link className="button small" scroll={false} prefetch={false} href={query({ id: item.key })}>검토</Link><p>{item.next}</p></td></tr>)}</tbody></table></div>
      {!rows.length && <div className="empty"><b>{queues.failed.length ? "확인할 수 있는 요청이 없습니다." : "이 조건에 해당하는 요청이 없습니다."}</b>{queues.failed.length ? "조회 실패를 0건으로 처리하지 않습니다." : "처리 기록에서 완료 결과를 확인하세요."}</div>}
      <p className="table-note">원본 유형별 최대 25~50건 조회 · 검색은 현재 불러온 목록에서 적용합니다. 문의는 기존 메일함에서 회신하고 처리 상태를 기록합니다.</p>
      {queues.results.some(source => source.result.ok && (source.result.data.nextOffset != null || source.result.data.nextCursor)) && <div className="panel-foot flex">{queues.results.map(source => source.result.ok && (source.result.data.nextOffset != null || source.result.data.nextCursor) ? <Link className="button small" prefetch={false} href={query({ kind: source.kind, id: undefined, offset: source.result.data.nextOffset ?? undefined, cursor: source.result.data.nextCursor ?? undefined })} key={source.kind}>{names[source.kind]} 다음 목록</Link> : null)}</div>}
    </section><section className="panel pad sticky-detail" aria-label="선택한 요청">{selected ? <RequestDetail item={selected} admin={admin} secret={secret} /> : <div className="empty"><b>{id ? "선택한 요청이 현재 목록에 없습니다." : "요청을 선택하세요."}</b>다른 요청으로 자동 변경하지 않습니다. 목록에서 다시 선택하세요.</div>}</section></div>
    {(tab === "open" || tab === "correction") && <details className="panel"><summary>고급 묶음 처리</summary><div className="panel-body"><p className="small muted">계정·보낸이·접수시각으로 묶어서 내림/유지할 때 사용합니다. 선택한 프로젝트 이름과 영향 범위를 확인한 뒤 처리하세요.</p><Link href="/admin/audit?tab=requests" prefetch={false} className="button mt-sm">내림 요청 묶음 처리 열기 →</Link></div></details>}
  </div>;
}

function RequestDetail({ item, admin, secret }: { item: WorkspaceRequest; admin: Props["admin"]; secret: string }) {
  return <div className="stack"><div className="detail-header"><div><div className="eyebrow">{item.key} / {item.type}</div><h2>{item.name}</h2><p>{item.kind === "contact" ? "받은 메일 수동 접수" : item.kind === "intro" || item.kind === "takedown" ? "프로젝트 상세 요청 폼" : "사용자 글 원본"}{item.kind === "contact" ? ` · 원본 판 ${item.record.version}` : item.kind === "replies" ? ` · 원본 판 ${item.record.reply.reviewVersion}` : ""}</p></div><span className="tag amber">{item.status}</span></div>
    {item.kind === "replies" && <div className="evidence-box"><b>답장 대상 원문</b><p>{item.record.targetBody ?? "원문이 삭제되었거나 공개되지 않습니다."}</p></div>}
    <div className="evidence-box"><b>{["feedback", "replies", "reactions"].includes(item.kind) ? "글 원문" : "요청 원문"}</b><p className="request-original">{item.body}</p></div>
    <dl className="facts"><dt>프로젝트</dt><dd>{item.slug ? <Link className="text-button" href={`/admin/products/${item.slug}`}>{item.name} 상세</Link> : "연결된 프로젝트 —"}</dd><dt>접수·작성</dt><dd>{formatDetailTime(item.at)}</dd><dt>대기·약속</dt><dd>{formatWait(item.waitHours)} · {item.kind === "takedown" ? "내림 요청 24시간" : "별도 처리 약속 없음"}</dd><dt>다음 행동</dt><dd>{item.next}</dd>{item.kind === "takedown" && <><dt>이전 처리</dt><dd>{item.record.previousOutcome === "removed" ? "이전 공개 중단" : item.record.previousOutcome === "dismissed" ? "이전 유지" : "이전 완료 기록 없음"}</dd><dt>공개·소유</dt><dd>{item.record.product?.status ?? "—"} · {item.record.owner ?? "저장소 계정 —"}</dd></>}{item.kind === "contact" && <><dt>회신 주소</dt><dd>{item.record.senderEmail}</dd><dt>최근 처리</dt><dd>{item.record.updatedBy} · {formatDetailTime(item.record.updatedAt)}</dd></>}</dl>
    {item.kind === "takedown" ? <PrototypeTakedownAction key={item.key} entry={{ slug: item.record.slug, product: item.record.product ? { name: item.record.product.name } : null }} /> : item.kind === "intro" ? <PrototypeIntroAction key={item.key} entry={{ id: item.record.id, slug: item.record.slug, product: item.record.product ? { name: item.record.product.name, tagline: item.record.product.tagline, status: item.record.product.status } : null }} /> : item.kind === "contact" ? <><div className="notice blue">회신은 기존 메일함에서 보냅니다. 이 화면의 완료 상태가 메일 발송 완료를 대신하지 않습니다.</div><ContactUpdateForm key={`${item.key}-${item.record.version}`} csrfToken={adminRequestToken("contact-requests", admin, secret)} expiresAt={admin.exp} id={item.record.id} version={item.record.version} status={item.record.status} handlingNote={item.record.handlingNote} /></> : item.kind === "feedback" ? <><details className="panel"><summary>글 상세·외부 전송 상태</summary><div className="panel-body"><FeedbackItem feedback={item.record} /></div></details><div className="notice blue">숨김은 사이트 공개를 중단합니다. 전송 중이거나 이미 전송된 GitHub 이슈는 남을 수 있습니다. 공개 복원은 GitHub에 다시 보내지 않습니다.</div><FeedbackReviewForm key={`${item.key}-${item.record.reviewState}`} id={item.record.id} reviewState={item.record.reviewState} csrfToken={createHmac("sha256", secret).update(`feedback-admin:${admin.login}:${admin.exp}`).digest("hex")} expiresAt={admin.exp} /></> : item.kind === "replies" ? <MakerReplyReviewForm key={`${item.key}-${item.record.reply.reviewVersion}`} csrfToken={adminRequestToken("maker-replies", admin, secret)} expiresAt={admin.exp} id={item.record.reply.id} version={item.record.reply.reviewVersion} reviewState={item.record.reply.reviewState} /> : <ReactionReviewForm key={item.key} id={item.record.id} comment={item.record.comment} csrfToken={reactionAdminCsrf(admin, secret)} expiresAt={admin.exp} />}
    <p className="small muted">공개 전 후보의 반려와 별도 업무입니다. 처리 결과는 원본 요청과 감사 기록에 남습니다.</p>
  </div>;
}
