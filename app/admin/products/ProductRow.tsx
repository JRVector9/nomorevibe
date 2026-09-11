"use client";

import { useActionState } from "react";
import Link from "next/link";
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

const STATUS: Record<string, { label: string; className: string }> = {
  verified: { label: "검증됨", className: "bg-up/10 text-up" },
  seeded: { label: "미클레임", className: "bg-bg-soft text-fg-2" },
  unverified: { label: "검증 대기", className: "bg-warn/10 text-warn" },
  banned: { label: "차단됨", className: "bg-down/10 text-down" },
};
const menuButton = "block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] font-semibold hover:bg-bg-hover disabled:opacity-50";

/**
 * 제품 표 한 줄.
 *
 * 카드 한 장(186px)에 차단·초대 버튼과 그 설명을 줄마다 되풀이하면 100건이 화면 19개였다.
 * 줄에는 이름·주소·상태·등록일만 두고, 행동은 끝의 ⋯ 메뉴에 넣는다. 설명은 표 위에 한 번.
 */
/** dropUp: 표 아래쪽 줄은 메뉴를 위로 연다 — 표를 감싼 스크롤 상자 밖으로 나가면 잘린다 */
export function ProductRow({ product, dropUp = false }: { product: AdminProduct; dropUp?: boolean }) {
  const [state, action, pending] = useActionState<ReviewState, FormData>(setProductBan, null);
  const [inviteState, inviteAction, inviting] = useActionState<ReviewState, FormData>(markClaimInvite, null);
  const banned = product.status === "banned";
  const status = STATUS[product.status] ?? { label: product.status, className: "bg-bg-soft text-fg-2" };
  const error = state?.error ? `차단: ${state.error}` : inviteState?.error ? `초대: ${inviteState.error}` : null;

  return (
    <tr className={`border-t border-line ${banned ? "bg-bg-soft text-fg-3" : ""}`}>
      <td className="px-3 py-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <a href={`/p/${product.slug}`} target="_blank" rel="noreferrer noopener" className="truncate font-semibold hover:text-accent">{product.name}</a>
          <a href={product.url} target="_blank" rel="noreferrer noopener" className="truncate font-mono text-fg-3 hover:text-accent">
            {product.url.replace(/^https?:\/\//, "")}
          </a>
        </div>
        {error && <p className="text-[13px] text-down">{error}</p>}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5"><span className={`rounded px-1.5 py-0.5 font-semibold ${status.className}`}>{status.label}</span></td>
      <td className="truncate px-2 py-1.5 text-fg-3">
        {product.source === "crawler" ? "수집" : product.source}
        {product.unclaimed && product.invitedAt && ` · 클레임 초대 보냄 · ${product.invitedAt}`}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-fg-3">{product.listedAt}</td>
      <td className="relative px-2 py-1 text-right">
        <details className="inline-block text-left">
          <summary aria-label={`${product.name} 관리`} className="cursor-pointer list-none rounded-md px-2 py-0.5 text-[15px] text-fg-3 hover:bg-bg-hover">⋯</summary>
          <div className={`absolute right-2 z-10 w-[240px] rounded-lg border border-line bg-bg-card p-1.5 shadow-lg ${dropUp ? "bottom-full" : "top-full"}`}>
            <form action={action}>
              <input type="hidden" name="slug" value={product.slug} />
              <button type="submit" name="action" value={banned ? "unban" : "ban"} disabled={pending}
                className={`${menuButton} ${banned ? "text-fg-2" : "text-down"}`}>{banned ? "차단 해제" : "차단"}</button>
            </form>
            {/* 주인이 없는 제품에만. 보내는 것은 GitHub에서 운영자가 직접 하고 여기서는 보냈다고만 표시한다 */}
            {product.unclaimed && !banned && (
              product.invitedAt ? (
                // 제출 전에 표시를 눌렀을 수 있다. 링크는 남겨 다시 꺼낼 수 있게 한다
                product.inviteUrl && <a href={product.inviteUrl} target="_blank" rel="noreferrer noopener" className={`${menuButton} text-fg-2`}>이슈 다시 열기 ↗</a>
              ) : product.inviteUrl ? (
                <form action={inviteAction}>
                  <input type="hidden" name="slug" value={product.slug} />
                  <a href={product.inviteUrl} target="_blank" rel="noreferrer noopener" className={`${menuButton} text-accent`}>초대 이슈 열기 ↗</a>
                  <button type="submit" disabled={inviting} className={`${menuButton} text-fg-2`}>보냈음으로 표시</button>
                </form>
              ) : product.publicOriginMissing ? (
                <p className="px-2.5 py-1.5 text-[13px] text-fg-3">NEXT_PUBLIC_SITE_URL이 공개 주소가 아니라 초대 링크를 만들 수 없습니다</p>
              ) : (
                <p className="px-2.5 py-1.5 text-[13px] text-fg-3">GitHub 레포가 없어 초대할 곳이 없습니다</p>
              )
            )}
            <Link href={`/admin/products/${product.slug}`} prefetch={false} className={`${menuButton} text-fg-2`}>근거·업데이트 관리</Link>
          </div>
        </details>
      </td>
    </tr>
  );
}
