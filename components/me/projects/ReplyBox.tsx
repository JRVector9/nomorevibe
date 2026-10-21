"use client";

import { useId, useState } from "react";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { formatRelativeTime } from "@/lib/i18n/format";
import type { MakerReplyTarget } from "@/lib/me/contract";
import type { InboxItem, SavedReply } from "@/lib/me/maker";
import { makerErrorKey, makerRequest } from "./maker-request";

const LIMIT = 1000;

/**
 * 받은 의견 하나의 답장 — 처음 쓰기와 고치기가 같은 칸이다(대상 하나에 답장 하나).
 * 알림을 받을 글쓴이가 없으면(익명 한 줄·탈퇴·내 글, notifiable=false) 알림이 간다고 말하지 않는다. 서버가 알렸는지(notified)를 돌려준다
 */
export function ReplyBox({ csrfToken, targetType, targetId, reply, notifiable }: {
  csrfToken: string; targetType: MakerReplyTarget; targetId: string; reply: InboxItem["reply"]; notifiable: boolean;
}) {
  const t = useTranslations("me");
  const locale = useLocale();
  const now = useServerNow();
  const id = useId();
  const [current, setCurrent] = useState(reply);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(reply?.body ?? "");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    const body = draft.trim();
    if (pending || !body || body.length > LIMIT) return;
    setPending(true);
    setNotice(null);
    const result = await makerRequest<{ reply: SavedReply }>("/api/me/maker/replies", "PUT", csrfToken, { targetType, targetId, body });
    setPending(false);
    if (!result.ok) { setNotice({ ok: false, text: t(makerErrorKey(result.code)) }); return; }
    const saved = result.data.reply;
    setCurrent({ id: saved.id, body: saved.body, reviewState: saved.reviewState, updatedAt: saved.updatedAt });
    setOpen(false);
    setNotice({ ok: true, text: saved.reviewState === "held" ? t("projects.reply.held") : saved.notified ? t("projects.reply.sent")
      : saved.created ? t("projects.reply.sentQuiet") : t("projects.reply.updated") });
  }

  return (
    <div className="me-proj-reply">
      {current && !open && (
        <div className="me-proj-reply-mine">
          <p className="me-proj-sub">{t("projects.reply.mine", { time: formatRelativeTime(current.updatedAt, now, locale) })}</p>
          <p className="me-proj-quote">{current.body}</p>
          {/* 예전에 검토 대기로 남은 답장 — 글쓴이에게 보이지 않는다. 고쳐 저장하면 공개된다 */}
          {current.reviewState !== "accepted" && <p className="me-proj-notice is-bad">{t("projects.reply.held")}</p>}
        </div>
      )}
      {open ? (
        <form className="me-proj-reply-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="sr-only" htmlFor={`${id}-reply`}>{t("projects.reply.label")}</label>
          <textarea id={`${id}-reply`} className="me-proj-textarea" value={draft} maxLength={LIMIT} rows={3} autoFocus
            placeholder={t(notifiable ? "projects.reply.placeholder" : "projects.reply.placeholderQuiet")} onChange={(event) => setDraft(event.target.value)} />
          <div className="me-proj-foot">
            <span className="me-proj-count">{t("projects.reply.count", { count: draft.trim().length, max: LIMIT })}</span>
            <div className="me-proj-acts">
              <button type="button" className="me-proj-btn is-ghost" disabled={pending} onClick={() => { setOpen(false); setDraft(current?.body ?? ""); }}>{t("projects.reply.cancel")}</button>
              <button type="submit" className="me-proj-btn is-primary" disabled={pending || !draft.trim()}>{t("projects.reply.submit")}</button>
            </div>
          </div>
        </form>
      ) : (
        <div className="me-proj-acts">
          <button type="button" className={current ? "me-proj-btn" : "me-proj-btn is-primary"} onClick={() => { setOpen(true); setNotice(null); }}>
            {current ? t("projects.reply.edit") : t("projects.reply.label")}
          </button>
        </div>
      )}
      <p role="status" aria-live="polite" className={notice ? (notice.ok ? "me-proj-notice is-ok" : "me-proj-notice is-bad") : "sr-only"}>{notice?.text ?? ""}</p>
    </div>
  );
}
