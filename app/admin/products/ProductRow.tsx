"use client";

import { useActionState } from "react";
import { setProductBan, type ReviewState } from "../actions";

export type AdminProduct = {
  slug: string;
  name: string;
  url: string;
  status: string;
  source: string;
  unclaimed: boolean;
  listedAt: string;
};

const STATUS_LABELS: Record<string, string> = {
  verified: "검증됨",
  seeded: "미클레임",
  unverified: "검증 대기",
  banned: "차단됨",
};

export function ProductRow({ product }: { product: AdminProduct }) {
  const [state, action, pending] = useActionState<ReviewState, FormData>(setProductBan, null);
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
      <a
        href={`/admin/products/${product.slug}`}
        className="mt-3 inline-block text-[13px] font-semibold text-accent hover:underline"
      >
        근거·업데이트 관리
      </a>
      {state?.error && <p className="mt-2 text-[13px] text-down">{state.error}</p>}
    </li>
  );
}
