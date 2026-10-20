"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useTranslations } from "@/lib/i18n/context";
import { makerErrorKey, makerRequest } from "./maker-request";

const TAGLINE_MAX = 200;
const DESCRIPTION_MAX = 4000;

/** 소개 고치기 — 한 줄 소개와 소개. 바뀐 칸만 보낸다(그대로 둔 한 줄 소개에 «메이커가 씀»이 붙지 않게) */
export function IntroEditor({ csrfToken, productId, tagline, description, children }: {
  csrfToken: string; productId: number; tagline: string; description: string; children?: React.ReactNode;
}) {
  const t = useTranslations("me");
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [nextTagline, setNextTagline] = useState(tagline);
  const [nextDescription, setNextDescription] = useState(description);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    const changes: { tagline?: string; description?: string } = {};
    if (nextTagline.trim() !== tagline) changes.tagline = nextTagline.trim();
    if (nextDescription.trim() !== description) changes.description = nextDescription.trim();
    if (Object.keys(changes).length === 0) { setOpen(false); return; }
    if (pending) return;
    setPending(true);
    setNotice(null);
    const result = await makerRequest<{ state: "applied" }>("/api/me/maker/intro", "PUT", csrfToken, { productId, ...changes });
    setPending(false);
    if (!result.ok) { setNotice({ ok: false, text: t(makerErrorKey(result.code)) }); return; }
    setOpen(false);
    setNotice({ ok: true, text: t("projects.intro.saved") });
    router.refresh();
  }

  return (
    <div className="me-proj-intro">
      <div className="me-proj-acts">
        {children}
        {!open && (
          <button type="button" className="me-proj-btn" onClick={() => { setOpen(true); setNotice(null); setNextTagline(tagline); setNextDescription(description); }}>
            {t("projects.intro.edit")}
          </button>
        )}
      </div>
      {open && (
        <form className="me-proj-intro-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label htmlFor={`${id}-tagline`}>{t("projects.intro.tagline")}</label>
          <input id={`${id}-tagline`} className="me-proj-input" value={nextTagline} maxLength={TAGLINE_MAX} required autoFocus onChange={(event) => setNextTagline(event.target.value)} />
          <span className="me-proj-count">{t("projects.intro.count", { count: nextTagline.trim().length, max: TAGLINE_MAX })}</span>
          <label htmlFor={`${id}-description`}>{t("projects.intro.description")}</label>
          <textarea id={`${id}-description`} className="me-proj-textarea" value={nextDescription} maxLength={DESCRIPTION_MAX} rows={5} required
            onChange={(event) => setNextDescription(event.target.value)} />
          <div className="me-proj-foot">
            <span className="me-proj-count">{t("projects.intro.count", { count: nextDescription.trim().length, max: DESCRIPTION_MAX })}</span>
            <div className="me-proj-acts">
              <button type="button" className="me-proj-btn is-ghost" disabled={pending} onClick={() => setOpen(false)}>{t("projects.intro.cancel")}</button>
              <button type="submit" className="me-proj-btn is-primary" disabled={pending || !nextTagline.trim() || !nextDescription.trim()}>{t("projects.intro.save")}</button>
            </div>
          </div>
        </form>
      )}
      <p role="status" aria-live="polite" className={notice ? (notice.ok ? "me-proj-notice is-ok" : "me-proj-notice is-bad") : "sr-only"}>{notice?.text ?? ""}</p>
    </div>
  );
}
