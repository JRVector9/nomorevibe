"use client";

import { useState } from "react";
import { ConfirmAction } from "../components/ConfirmAction";
import { resultError, resultToast, useAdminToast } from "../components/Toast";
import { setProductBan } from "../actions";
import { BAN_REASONS, banReasonLabel } from "./ban-reasons";

/** 작업 로그를 이 제품으로 거른 화면(C2) */
export const historyLink = (slug: string) => ({ label: "기록 보기", href: `/admin/activity?target=${encodeURIComponent(slug)}` });

/** 해제 — 알림의 되돌리기에서 부르면 undo 로 남긴다 */
export function unbanBySlug(slug: string, undo = false) {
  const form = new FormData();
  form.set("slug", slug);
  form.set("action", "unban");
  if (undo) form.set("undo", "1");
  return setProductBan(null, form);
}

/** 차단 뒤 알림 — 되돌리기는 해제다 */
export function bannedToast(slug: string, message: string) {
  return { message, link: historyLink(slug), undo: { run: () => unbanBySlug(slug, true) } };
}

/**
 * 차단·차단 해제 버튼(2026-10-08 UX 감사 ADM-06·12) — 목록 ⋯ 메뉴, 소개 확인 줄, 제품 상세가 함께 쓴다.
 *
 * 차단은 확인 창에서 대상 이름을 보이고 사유를 꼭 고르게 한다. 끝나면 알림에 '되돌리기(10초)'와 '기록 보기'를 단다.
 * 해제는 바로 한다 — 차단 전 상태로 돌아갈 뿐이고, 다시 차단하려면 사유를 고르게 된다.
 */
export function BanAction({ slug, name, banned, className }: { slug: string; name: string; banned: boolean; className: string }) {
  const toast = useAdminToast();
  const [pending, setPending] = useState(false);

  if (banned) {
    return (
      <button type="button" disabled={pending} className={className} onClick={async () => {
        setPending(true);
        try {
          toast.show(resultToast(await unbanBySlug(slug), { message: `차단 해제함 · ${name}`, link: historyLink(slug) }));
        } finally {
          setPending(false);
        }
      }}>{pending ? "푸는 중…" : "차단 해제"}</button>
    );
  }

  return (
    <ConfirmAction
      title="이 제품을 차단합니다"
      targets={[name]}
      summary={<ul className="list-disc pl-5 text-[13px] leading-[1.6]">
        <li>공개 목록과 상세 페이지에서 곧바로 사라집니다.</li>
        <li>같은 주소를 다시 수집하거나 다시 등록할 수 없게 막힙니다.</li>
        <li>잘못 눌렀으면 알림의 되돌리기나 차단 해제로 풉니다.</li>
      </ul>}
      confirmLabel="차단"
      reasons={{ label: "차단 사유", options: BAN_REASONS }}
      note={{ label: "메모", optional: true, maxLength: 500 }}
      onConfirm={async ({ reason = "", note = "" }) => {
        const form = new FormData();
        form.set("slug", slug);
        form.set("action", "ban");
        form.set("reason", reason);
        if (note) form.set("note", note);
        const result = await setProductBan(null, form);
        if (!resultError(result)) toast.show(bannedToast(slug, `차단함 · ${name} · ${banReasonLabel(reason)}`));
        return result;
      }}
      trigger={(open) => <button type="button" onClick={open} aria-haspopup="dialog" className={className}>차단</button>}
    />
  );
}
