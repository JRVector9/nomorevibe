"use client";

import "./try.css";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { REACTION_VERDICTS, type ReactionVerdict } from "@/lib/me/contract";
import type { ReactionMine, ReactionSummary } from "@/lib/domain/reactions/contract";
import { Icon } from "@/components/home/icons";
import { ReactionFields, type ReactionDraft } from "./ReactionFields";
import { deleteReactionRequest, phoneWidth, putReactionRequest, type ReactionBody } from "./reaction-api";
import { forgetReacted, rememberReacted } from "./reacted";

type Loaded = { mine: ReactionMine | null; summary: ReactionSummary | null; csrfToken: string | null };

/**
 * 상세 써보기 판(피드백 설계 M1 A·B, 휴대폰 M2) — 「제품 방문하기」 바로 아래.
 *
 * 평가 단추를 누르는 순간 저장한다(로그인 없음). 태그·한 줄은 그 뒤에 펼치는 덤이다 — PC 는 판 아래, 휴대폰은 아래 시트.
 * 상세 HTML 은 엣지에 4분 남으므로 내 평가와 요약은 브라우저에서 따로 읽는다(no-store). 판의 높이는 처음부터 잡아 두어
 * 읽기가 끝나도 아래 내용이 밀리지 않는다. 결과는 읽기 도구에 상태 문구로 한 번 알린다.
 */
export function TryPanel({ slug, name }: { slug: string; name: string }) {
  const t = useTranslations("me");
  const locale = useLocale();
  const headingId = useId();
  const sheetTitleId = useId();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [hidden, setHidden] = useState(false);
  const [draft, setDraft] = useState<ReactionDraft | null>(null);
  const [sheet, setSheet] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const trap = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const form = useRef<HTMLFormElement>(null);
  // 읽기가 끝나기 전에 누르면 그 읽기(로그인이면 CSRF 값)를 기다린다
  const ready = useRef<Promise<Loaded | null> | null>(null);
  const mine = loaded?.mine ?? null;

  useEffect(() => {
    const controller = new AbortController();
    ready.current = fetch(`/api/products/${encodeURIComponent(slug)}/reactions`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      // 꺼져 있으면(404) 판을 그리지 않는다
      if (response.status === 404) {
        setHidden(true);
        return null;
      }
      if (!response.ok) throw new Error("reactions_unavailable");
      const value = await response.json() as Loaded;
      const next = { mine: value.mine, summary: value.summary, csrfToken: value.csrfToken };
      setLoaded(next);
      return next;
    }).catch(() => {
      if (controller.signal.aborted) return null;
      const next = { mine: null, summary: null, csrfToken: null };
      setLoaded(next);
      return next;
    });
    return () => controller.abort();
  }, [slug]);

  useEffect(() => {
    const node = dialog.current;
    if (!sheet || !node || node.open) return;
    node.showModal();
    // 시트 뒤 페이지가 같이 밀리지 않게 — 닫으면 돌려 둔다
    const style = document.documentElement.style;
    const previous = style.overflow;
    style.overflow = "hidden";
    return () => { style.overflow = previous; };
  }, [sheet]);

  async function save(body: Pick<ReactionBody, "verdict" | "tags" | "comment">, done: "picked" | "sent"): Promise<boolean> {
    setPending(true);
    const phone = phoneWidth();
    const result = await putReactionRequest(slug, {
      // 판의 단추는 panel, 시트의 보내기는 sheet
      ...body, source: sheet ? "sheet" : "panel", device: phone ? "phone" : "desktop", locale,
      website: trap.current?.value ?? "",
    }, (loaded ?? await ready.current)?.csrfToken ?? null);
    setPending(false);
    if (!result.ok) {
      setMessage(t(result.errorKey));
      return false;
    }
    rememberReacted(slug);
    setLoaded((current) => ({ csrfToken: current?.csrfToken ?? null, mine: result.mine, summary: result.summary }));
    const verdict = t(`verdict.${result.mine.verdict}`);
    setMessage(done === "picked" ? t("try.savedMore", { verdict }) : t(result.mine.commentState === "held" ? "try.sentHeld" : "try.sent"));
    return true;
  }

  function open(verdict: ReactionVerdict, trigger: HTMLButtonElement | null, focusEditor = false, saved = mine) {
    returnFocus.current = trigger;
    setDraft((current) => ({ verdict, tags: current?.tags ?? saved?.tags ?? [], comment: current?.comment ?? saved?.comment ?? "" }));
    if (phoneWidth()) setSheet(true);
    // 「바꾸기」는 펼치면 사라진다 — 초점을 펼친 칸의 첫 단추로 옮긴다
    else if (focusEditor) requestAnimationFrame(() => form.current?.querySelector<HTMLElement>("button:not(:disabled), input")?.focus({ preventScroll: true }));
  }

  async function pick(verdict: ReactionVerdict, trigger: HTMLButtonElement) {
    if (pending) return;
    // 읽기 전에 눌렀으면 기다린다 — 남겨 둔 태그·한 줄을 빈 값으로 덮지 않게
    const saved = (loaded ?? await ready.current)?.mine ?? null;
    open(verdict, trigger, false, saved);
    // 이미 같은 평가면 다시 보내지 않는다 — 펼치기만
    if (saved?.verdict === verdict) return;
    await save({ verdict, tags: saved?.tags ?? [], comment: saved?.comment ?? null }, "picked");
  }

  function close() {
    setDraft(null);
    if (dialog.current?.open) dialog.current.close();
    setSheet(false);
    // 돌아갈 단추가 사라졌으면(「바꾸기」) 고른 평가 단추로
    requestAnimationFrame(() => (returnFocus.current?.isConnected ? returnFocus.current
      : panel.current?.querySelector<HTMLElement>(".try-row [aria-pressed=\"true\"], .try-row button"))?.focus({ preventScroll: true }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || pending) return;
    if (await save({ verdict: draft.verdict, tags: draft.tags, comment: draft.comment.trim() || null }, "sent")) close();
  }

  async function remove() {
    if (pending) return;
    setPending(true);
    const result = await deleteReactionRequest(slug, (loaded ?? await ready.current)?.csrfToken ?? null);
    setPending(false);
    if (!result.ok) return setMessage(t(result.errorKey));
    forgetReacted(slug);
    setLoaded((current) => ({ csrfToken: current?.csrfToken ?? null, mine: null, summary: result.summary }));
    setMessage(t("try.deleted"));
    close();
  }

  if (hidden) return null;
  const summary = loaded?.summary;
  // 방금 한 일의 결과가 있으면 그 문구가 내 평가 자리를 대신한다(요약은 그대로 둔다)
  const meta = [
    message ?? (mine ? t("try.saved", { verdict: t(`verdict.${mine.verdict}`) }) : null),
    summary ? t("try.summary", {
      tried: formatNumber(summary.tried, locale), good: formatNumber(summary.good, locale),
      meh: formatNumber(summary.meh, locale), bad: formatNumber(summary.bad, locale),
    }) : loaded ? t("try.summaryFew") : null,
  ].filter(Boolean).join(" · ");
  const editor = draft && (
    <form ref={form} className="try-editor" onSubmit={submit} aria-busy={pending}
      onKeyDown={(event) => { if (event.key === "Escape" && !sheet) { event.preventDefault(); close(); } }}>
      <ReactionFields draft={draft} onChange={setDraft} showVerdict={sheet} variant="try" trap={trap} />
      <div className="try-actions">
        {mine && <button type="button" className="try-remove" onClick={remove} aria-disabled={pending}>{t("try.delete")}</button>}
        <button type="submit" className="try-send" aria-disabled={pending}>{t(pending ? "try.sending" : "try.send")}</button>
      </div>
    </form>
  );

  return (
    <section ref={panel} className="try-panel" aria-labelledby={headingId}>
      <p className="try-question">
        <strong id={headingId}>{t("try.question")}</strong> <span className="try-hint">{t("try.hint")}</span>
      </p>
      <div className="try-row">
        <div className="reaction-verdicts" role="group" aria-label={t("try.verdicts")}>
          {REACTION_VERDICTS.map((verdict) => (
            <button key={verdict} type="button" className="reaction-verdict" data-verdict={verdict} aria-pressed={mine?.verdict === verdict}
              aria-disabled={pending} onClick={(event) => pick(verdict, event.currentTarget)}>
              {t(`verdict.${verdict}`)}
            </button>
          ))}
        </div>
        {mine && !draft && (
          <button type="button" className="try-change"
            onClick={(event) => open(mine.verdict, event.currentTarget, true)}>
            {t("try.change")}
          </button>
        )}
      </div>
      {/* 자리를 늘 잡아 둔다 — 요약이 늦게 와도 아래가 밀리지 않는다 */}
      <p className="try-meta">{meta}</p>
      <p className="sr-only" role="status" aria-live="polite">{message}</p>
      {!sheet && editor}
      <dialog ref={dialog} className="try-sheet" aria-labelledby={sheetTitleId} onClose={() => { if (sheet) close(); }}>
        {sheet && (
          <>
            <div className="try-sheet-head">
              <div>
                <h2 id={sheetTitleId} className="try-sheet-title">{t("try.sheetTitle", { name })}</h2>
                <p className="try-hint">{t("try.sheetHint")}</p>
              </div>
              <button type="button" className="try-close" aria-label={t("try.close")} onClick={close}><Icon name="close" size={18} /></button>
            </div>
            {editor}
            <p className="sr-only" role="status" aria-live="polite">{message}</p>
          </>
        )}
      </dialog>
    </section>
  );
}
