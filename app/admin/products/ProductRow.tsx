"use client";

import { useActionState } from "react";
import { markClaimInvite, setProductBan, type ReviewState } from "../actions";

export type AdminProduct = {
  slug: string;
  name: string;
  url: string;
  status: string;
  source: string;
  unclaimed: boolean;
  listedAt: string;
  /** 미리 채운 GitHub 새 이슈 주소. 초대할 수 없는 제품이면 null */
  inviteUrl: string | null;
  /** 이슈 본문에 실을 공개 주소가 없다 — 레포가 있어도 초대를 만들 수 없다 */
  publicOriginMissing: boolean;
  invitedAt: string | null;
};

const STATUS_LABELS: Record<string, string> = {
  verified: "검증됨",
  seeded: "미클레임",
  unverified: "검증 대기",
  banned: "차단됨",
};

export function ProductRow({ product }: { product: AdminProduct }) {
  const [state, action, pending] = useActionState<ReviewState, FormData>(setProductBan, null);
  const [inviteState, inviteAction, inviting] = useActionState<ReviewState, FormData>(markClaimInvite, null);
  const banned = product.status === "banned";

  return (
    <li className={`rounded-[12px] border p-[18px] ${banned ? "border-line bg-bg-soft" : "border-line bg-bg-card"}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <a href={`/p/${product.slug}`} target="_blank" rel="noreferrer noopener" className="text-[14px] font-bold hover:text-accent">
          {product.name}
        </a>
        <span className="text-[13px] font-semibold text-fg-3">
          {STATUS_LABELS[product.status] ?? product.status}
          {product.source === "crawler" && " · 수집"}
        </span>
        <span className="ml-auto font-mono text-[13px] text-fg-3">{product.listedAt}</span>
      </div>

      <a
        href={product.url}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-1 block text-[13px] text-fg-2 hover:text-accent"
      >
        {product.url.replace(/^https?:\/\//, "")}
      </a>

      <form action={action} className="mt-3 flex items-center gap-2">
        <input type="hidden" name="slug" value={product.slug} />
        <button
          type="submit"
          name="action"
          value={banned ? "unban" : "ban"}
          disabled={pending}
          className={`rounded-lg border px-3 py-1.5 text-[13px] font-semibold disabled:opacity-50 ${
            banned ? "border-line text-fg-2 hover:text-fg" : "border-down/40 bg-down/10 text-down"
          }`}
        >
          {banned ? "차단 해제" : "차단"}
        </button>
        <span className="text-[13px] text-fg-3">
          {banned ? "차단 전 상태로 되돌립니다" : "행은 남아 같은 URL의 재등록·재수집을 막습니다"}
        </span>
      </form>
      {/* 주인이 없는 제품에만. 보내는 것은 GitHub에서 운영자가 직접 하고 여기서는 보냈다고만 표시한다 */}
      {product.unclaimed && !banned && (
        product.invitedAt ? (
          <p className="mt-3 flex flex-wrap items-center gap-3 text-[13px] text-fg-3">
            <span>클레임 초대 보냄 · {product.invitedAt}</span>
            {/* 제출 전에 표시를 눌렀을 수 있다. 링크는 남겨 다시 꺼낼 수 있게 한다 */}
            {product.inviteUrl && (
              <a href={product.inviteUrl} target="_blank" rel="noreferrer noopener" className="underline hover:text-fg">
                이슈 다시 열기 ↗
              </a>
            )}
          </p>
        ) : product.inviteUrl ? (
          <form action={inviteAction} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="slug" value={product.slug} />
            <a
              href={product.inviteUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-lg border border-accent/35 bg-accent-soft px-3 py-1.5 text-[13px] font-semibold text-accent"
            >
              초대 이슈 열기 ↗
            </a>
            <button
              type="submit"
              disabled={inviting}
              className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-fg-2 hover:text-fg disabled:opacity-50"
            >
              보냈음으로 표시
            </button>
            <span className="text-[13px] text-fg-3">레포에 미리 채운 이슈를 직접 제출한 뒤 표시합니다</span>
          </form>
        ) : product.publicOriginMissing ? (
          <p className="mt-3 text-[13px] text-fg-3">
            NEXT_PUBLIC_SITE_URL이 공개 주소가 아니라 초대 링크를 만들 수 없습니다
          </p>
        ) : (
          <p className="mt-3 text-[13px] text-fg-3">GitHub 레포가 없어 초대할 곳이 없습니다</p>
        )
      )}
      <a
        href={`/admin/products/${product.slug}`}
        className="mt-3 inline-block text-[13px] font-semibold text-accent hover:underline"
      >
        근거·업데이트 관리
      </a>
      {/* 둘을 한 줄에 합치면 남아 있는 차단 오류가 방금 난 초대 오류를 가린다 */}
      {state?.error && <p className="mt-2 text-[13px] text-down">차단: {state.error}</p>}
      {inviteState?.error && <p className="mt-2 text-[13px] text-down">초대: {inviteState.error}</p>}
    </li>
  );
}
