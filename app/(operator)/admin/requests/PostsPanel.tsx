import { createHmac } from "node:crypto";
import Link from "next/link";
import type { FeedbackReviewState } from "@/lib/domain/feedback/contract";
import { feedbackAdminQueue } from "@/lib/domain/feedback/repository";
import { heldReactionComments } from "@/lib/domain/reactions/review";
import { formatDetailTime } from "@/lib/format/time";
import { adminRequestToken } from "@/lib/operations/admin-requests-csrf";
import { readRequestSection } from "@/lib/operations/admin-request-workspace";
import { makerReplyQueue } from "@/lib/operations/maker-reply-review";
import { FeedbackItem } from "@/components/product-detail/FeedbackList";
import { FeedbackReviewForm } from "../feedback/FeedbackReviewForm";
import { reactionAdminCsrf } from "../reactions/csrf";
import { ReactionReviewForm } from "../reactions/ReactionReviewForm";
import { MakerReplyReviewForm } from "./RequestForms";
import { ReadUnavailable } from "./WorkspaceParts";

const labels = { held: "보류", accepted: "공개", rejected: "거절·숨김", all: "전체" };
const reasons: Record<string, string> = { link: "링크", mention: "멘션·이메일", repeated: "반복 글자·낱말", lure: "미끼 문구" };
type Params = Record<string, string | string[] | undefined>;
type Props = { params: Params; admin: { login: string; exp: number }; secret: string };
const reviewState = (params: Params): FeedbackReviewState | "all" => typeof params.state === "string" && Object.hasOwn(labels, params.state)
  ? params.state as FeedbackReviewState | "all" : "held";

export async function PostsPanel(props: Props) {
  const kind = props.params.kind === "replies" ? "replies" : props.params.kind === "reactions" ? "reactions" : "feedback";
  const kinds = { feedback: "피드백", replies: "메이커 답장", reactions: "써봤어요 한 줄" };
  return <div className="rw-stack"><nav className="rw-kind-tabs" aria-label="검수할 글 유형">{Object.entries(kinds).map(([value, label]) =>
    <Link key={value} prefetch={false} href={`/admin/requests?tab=posts&kind=${value}`} aria-current={kind === value ? "page" : undefined}>{label}</Link>)}</nav>
    {kind === "replies" ? await Replies(props) : kind === "reactions" ? await Reactions(props) : await Feedback(props)}
  </div>;
}

function ReviewFilter({ kind, state, q }: { kind: "feedback" | "replies"; state: string; q?: string }) {
  return <form action="/admin/requests" className="rw-toolbar"><input type="hidden" name="tab" value="posts" /><input type="hidden" name="kind" value={kind} />
    <label>상태 <select name="state" defaultValue={state}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {q !== undefined && <label>찾기 <input name="q" defaultValue={q} maxLength={120} placeholder="댓글 ID·프로젝트·제목" /></label>}
    <button className="rw-button">조회</button></form>;
}

async function Feedback({ params, admin, secret }: Props) {
  const state = reviewState(params);
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 120) : "";
  const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
  const result = await readRequestSection("feedback", () => feedbackAdminQueue({ state, q, cursor }));
  const csrfToken = createHmac("sha256", secret).update(`feedback-admin:${admin.login}:${admin.exp}`).digest("hex");
  const next = new URLSearchParams({ tab: "posts", kind: "feedback", state, q });
  if (result.ok && result.data.nextCursor) next.set("cursor", result.data.nextCursor);
  return <><ReviewFilter kind="feedback" state={state} q={q} />
    <p className="rw-note">숨김은 사이트 공개를 중단합니다. 아직 보내지 않은 GitHub 전송은 취소하지만 전송 중·결과 확인 필요·이미 전송된 외부 이슈는 남을 수 있습니다. 공개 복원은 GitHub에 다시 보내지 않습니다.</p>
    {!result.ok ? <ReadUnavailable title="피드백" /> : <><p className="rw-meta">피드백 {result.data.count.toLocaleString("ko-KR")}건 · 오래된 것부터</p>
      {!result.data.items.length && <p className="rw-empty">조건에 맞는 피드백이 없습니다.</p>}
      {result.data.items.map(item => <section className="rw-panel" key={`${item.id}-${item.reviewState}`}><header className="rw-panel-head"><h2><Link href={`/p/${item.slug}`} prefetch={false}>{item.productName}</Link></h2><span className="rw-state">{labels[item.reviewState]}</span></header><div className="rw-panel-body rw-stack">
        <FeedbackItem feedback={item} /><p className="rw-meta break-all">원본 댓글 {item.id} · {formatDetailTime(item.createdAt)}</p>
        <FeedbackReviewForm id={item.id} reviewState={item.reviewState} csrfToken={csrfToken} expiresAt={admin.exp} />
      </div></section>)}
      {result.data.nextCursor && <Link href={`/admin/requests?${next}`} prefetch={false} className="rw-button rw-next">다음 피드백</Link>}
    </>}</>;
}

async function Replies({ params, admin, secret }: Props) {
  const state = reviewState(params);
  const rawOffset = typeof params.offset === "string" ? Number(params.offset) : 0;
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? Math.min(rawOffset, 100000) : 0;
  const result = await readRequestSection("maker-replies", () => makerReplyQueue({ state, offset }));
  const csrf = { csrfToken: adminRequestToken("maker-replies", admin, secret), expiresAt: admin.exp };
  return <><ReviewFilter kind="replies" state={state} /><p className="rw-note">보류한 답장을 공개 승인하거나 숨길 수 있습니다. 공개 답장의 숨김·복원도 원본에 반영됩니다. 작성자나 다른 관리자가 바꾸면 새로 읽은 뒤 검토하세요.</p>
    {!result.ok ? <ReadUnavailable title="메이커 답장" /> : <><p className="rw-meta">답장 {result.data.count.toLocaleString("ko-KR")}건 · 오래된 것부터</p>
      {!result.data.items.length && <p className="rw-empty">조건에 맞는 답장이 없습니다.</p>}
      {result.data.items.map(({ reply, slug, productName, authorName, targetBody }) => <section className="rw-panel" key={`${reply.id}-${reply.reviewVersion}`}><header className="rw-panel-head"><h2><Link prefetch={false} href={`/p/${slug}`}>{productName}</Link></h2><span className="rw-state">{labels[reply.reviewState]}</span></header><div className="rw-panel-body rw-stack">
        <blockquote className="rw-quote">{targetBody ?? "원문이 삭제되었거나 공개되지 않습니다."}</blockquote><p className="rw-original">{reply.body}</p>
        <p className="rw-meta">작성자 {authorName} · 수정 {formatDetailTime(reply.updatedAt)} · 원본 판 {reply.reviewVersion}</p>
        <MakerReplyReviewForm {...csrf} id={reply.id} version={reply.reviewVersion} reviewState={reply.reviewState} />
      </div></section>)}
      {result.data.nextOffset !== null && <Link prefetch={false} href={`/admin/requests?tab=posts&kind=replies&state=${state}&offset=${result.data.nextOffset}`} className="rw-button rw-next">다음 답장</Link>}
    </>}</>;
}

async function Reactions({ admin, secret }: Props) {
  const result = await readRequestSection("reaction-comments", () => heldReactionComments());
  const csrfToken = reactionAdminCsrf(admin, secret);
  return <><p className="rw-note">자동 검사가 보류한 한 줄만 표시합니다. 공개하면 제품 메이커가 보고 답장할 수 있고, 숨기면 글쓴이에게만 보입니다. 처리 이력은 요청함 기록에서 확인할 수 있습니다.</p>
    {!result.ok ? <ReadUnavailable title="써봤어요 한 줄" /> : <><p className="rw-meta">보류 {result.data.count.toLocaleString("ko-KR")}건 · 오래된 {result.data.items.length}건 표시</p>
      {!result.data.items.length && <p className="rw-empty">보류한 한 줄이 없습니다.</p>}
      {/* Keep id-only keys: never replace the text a reviewer has already read during a background refresh. */}
      {result.data.items.map(item => <section key={item.id} className="rw-panel"><header className="rw-panel-head"><h2><Link prefetch={false} href={`/p/${item.slug}`}>{item.productName}</Link></h2><span className="rw-state">공개 보류</span></header><div className="rw-panel-body rw-stack">
        <p className="rw-original">{item.comment}</p><p className="rw-meta">{reasons[item.reason ?? ""] ?? item.reason ?? "사유 없음"} · {item.signedIn ? "로그인 계정" : "방문자"} · {formatDetailTime(item.updatedAt)}</p>
        <ReactionReviewForm id={item.id} comment={item.comment} csrfToken={csrfToken} expiresAt={admin.exp} />
      </div></section>)}
    </>}</>;
}
