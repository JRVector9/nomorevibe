import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { heldReactionComments } from "@/lib/domain/reactions/review";
import { formatDetailTime } from "@/lib/format/time";
import { reactionAdminCsrf } from "./csrf";
import { ReactionReviewForm } from "./ReactionReviewForm";
import { PageStamp } from "@/app/(operator)/admin/components/PageStamp";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "써봤어요 검수 — NoMoreVibe", robots: { index: false } };

const REASONS: Record<string, string> = { link: "링크", mention: "멘션·이메일", repeated: "반복 글자·낱말", lure: "미끼 문구" };

/**
 * 써봤어요 한 줄 검수 — 자동 검사가 보류한 한 줄(상세 써보기 판·마이페이지 써봤어요 탭)을 오래된 것부터 보여 준다.
 * 공개하면 메이커 받은 편지함에 오르고 답장할 수 있다. 숨기면 글쓴이에게만 보인다. 글쓴이가 고치면 자동 검사를 다시 거친다.
 */
export default async function AdminReactionsPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const secret = authSecret();
  if (!secret) throw new Error("admin_auth_unconfigured");
  const csrfToken = reactionAdminCsrf(admin, secret);
  const queue = await heldReactionComments();
  return <main className="space-y-5 p-5"><PageStamp />
    <h1 className="text-[22px] font-semibold">써봤어요 검수</h1>
    <p className="text-[14px] text-fg-2">링크·멘션·반복·미끼 문구로 보류한 한 줄입니다. 공개하면 제품 메이커가 보고 답장할 수 있고, 숨기면 글쓴이에게만 보입니다. 처리자와 시각은 작업 로그에 남습니다.</p>
    <p className="text-[14px] text-fg-2">보류 {queue.count.toLocaleString("ko-KR")}건{queue.count > queue.items.length ? ` · 오래된 ${queue.items.length.toLocaleString("ko-KR")}건만 표시` : ""}</p>
    {queue.items.length === 0 && <p className="text-[14px]">보류한 한 줄이 없습니다.</p>}
    {/* id 로만 그린다 — 글쓴이가 고치면 폼이 본 글을 들고 "바뀌었습니다"를 띄운다(다시 그리면 본 적 없는 글을 공개하게 된다) */}
    {queue.items.map((item) => <section key={item.id} className="space-y-3 rounded-xl border border-line p-4">
      <Link prefetch={false} href={`/p/${item.slug}`} className="text-[14px] underline">{item.productName}</Link>
      <p className="break-words text-[15px]">{item.comment}</p>
      <p className="text-[13px] text-fg-3">{REASONS[item.reason ?? ""] ?? item.reason ?? "사유 없음"} · {item.signedIn ? "로그인 계정" : "방문자"} · {formatDetailTime(item.updatedAt)}</p>
      <ReactionReviewForm id={item.id} comment={item.comment} csrfToken={csrfToken} expiresAt={admin.exp} />
    </section>)}
  </main>;
}
