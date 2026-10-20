"use client";

import "./alert-settings.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { LOCALE_CONFIG } from "@/lib/i18n/locales";
import { EMAIL_SETTING_CHOICES, type EmailMode, type EmailSettingKey } from "@/lib/me/contract";
import type { NotificationSettingsInput, NotificationSettingsResponse, NotificationSettingsView } from "@/lib/me/notification-settings";

type RowKey = `alertSettings.row.${EmailSettingKey | "commentReviewed"}`;
type NoteKey = `alertSettings.note.${"followedProject" | "followedMaker" | "followedCategory" | "newListingMine"}`;
type StatusKey = "alertSettings.saving" | "alertSettings.saved" | "alertSettings.saveFailed" | "alertSettings.rateLimited";
type WeekdayKey = `alertSettings.weekday.${0 | 1 | 2 | 3 | 4 | 5 | 6}`;
type Loaded = { data: NotificationSettingsResponse; csrf: string };
type Load = { status: "loading" } | { status: "failed" } | ({ status: "ready" } & Loaded);

/** 시안 3.4 ⑧ 차례 — 내 의견 검토 결과는 메일 칸 없이 «사이트 안만» */
const ROWS: ({ key: EmailSettingKey; label: RowKey; note?: NoteKey } | { key: null; label: RowKey; note?: undefined })[] = [
  { key: "makerReply", label: "alertSettings.row.makerReply" },
  { key: "followedProject", label: "alertSettings.row.followedProject", note: "alertSettings.note.followedProject" },
  { key: "followedMaker", label: "alertSettings.row.followedMaker", note: "alertSettings.note.followedMaker" },
  { key: "followedCategory", label: "alertSettings.row.followedCategory", note: "alertSettings.note.followedCategory" },
  { key: null, label: "alertSettings.row.commentReviewed" },
  { key: "newListingMine", label: "alertSettings.row.newListingMine", note: "alertSettings.note.newListingMine" },
];
/** 요일은 월요일부터 보인다(값은 0=일요일) */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

async function loadSettings(signal?: AbortSignal): Promise<Loaded> {
  const [me, settings] = await Promise.all([
    fetch("/api/me", { cache: "no-store", signal }), fetch("/api/me/notification-settings", { cache: "no-store", signal }),
  ]);
  const session = await me.json();
  if (!me.ok || !settings.ok || typeof session.csrfToken !== "string") throw new Error("alert_settings_unavailable");
  return { data: await settings.json(), csrf: session.csrfToken };
}

/**
 * 알림 설정(MY7) — 알림 탭(MY4)이 알림함 옆에 그린다. 사이트 안 알림함은 늘 켜져 있고 메일만 고른다.
 * 메일 발신 설정이 없으면(지금 운영) 메일 칸을 모두 숨기고 «사이트 안»만, 주소가 없으면 주소를 연결하라는 말만 보인다.
 * 단추마다 바로 저장한다 — 실패하면 마지막으로 저장된 값으로 되돌린다.
 */
export function AlertSettings({ userId }: { userId: number }) {
  const t = useTranslations("me");
  const locale = useLocale();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<StatusKey | "">("");
  const [digest, setDigest] = useState<{ weekday: number; hour: number } | null>(null);
  const saved = useRef<NotificationSettingsResponse | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    void loadSettings(controller.signal).then((loaded) => {
      saved.current = loaded.data;
      setLoad({ status: "ready", ...loaded });
    }).catch(() => { if (!controller.signal.aborted) setLoad({ status: "failed" }); });
    return () => controller.abort();
  }, [userId, attempt]);

  const save = useCallback(async (patch: NotificationSettingsInput) => {
    if (load.status !== "ready") return;
    const current = ++generation.current;
    const csrf = load.csrf;
    setLoad({ status: "ready", csrf, data: { ...load.data, settings: { ...load.data.settings, ...patch } } });
    setStatus("alertSettings.saving");
    try {
      const response = await fetch("/api/me/notification-settings", {
        method: "PUT", cache: "no-store",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ ...patch, locale }),
      });
      if (!response.ok) throw new Error(response.status === 429 ? "rate_limited" : "save_failed");
      const data: NotificationSettingsResponse = await response.json();
      saved.current = data;
      if (current === generation.current) { setLoad({ status: "ready", data, csrf }); setStatus("alertSettings.saved"); }
    } catch (error) {
      if (current !== generation.current) return;
      if (saved.current) setLoad({ status: "ready", data: saved.current, csrf });
      setStatus(error instanceof Error && error.message === "rate_limited" ? "alertSettings.rateLimited" : "alertSettings.saveFailed");
    }
  }, [load, locale]);

  const hourLabel = (hour: number) => new Intl.DateTimeFormat(LOCALE_CONFIG[locale].intl, { hour: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(2026, 0, 5, hour)));
  const weekdayLabel = (weekday: number) => t(`alertSettings.weekday.${weekday}` as WeekdayKey);
  const title = <h2 className="me-alert-set-title" id="me-alert-set-title">{t("alertSettings.title")}</h2>;

  if (load.status === "loading") {
    return <section className="me-alert-set" aria-labelledby="me-alert-set-title" aria-busy="true">{title}<p className="me-alert-set-desc">{t("alertSettings.loading")}</p></section>;
  }
  if (load.status === "failed") {
    return (
      <section className="me-alert-set" aria-labelledby="me-alert-set-title">
        {title}
        <p className="me-alert-set-desc">{t("alertSettings.loadFailed")}</p>
        <button type="button" className="me-alert-set-btn" onClick={() => { setLoad({ status: "loading" }); setAttempt((value) => value + 1); }}>{t("alertSettings.retry")}</button>
      </section>
    );
  }

  const { data } = load;
  const settings: NotificationSettingsView = data.settings;
  const email = data.emailAvailable;
  return (
    <section className="me-alert-set" aria-labelledby="me-alert-set-title">
      {title}
      <p className="me-alert-set-desc">{email ? t("alertSettings.siteAlwaysEmail") : t("alertSettings.siteAlways")}</p>
      {!email && <p className="me-alert-set-note">{data.emailConfigured ? t("alertSettings.emailNeedsAddress") : t("alertSettings.emailLater")}</p>}
      <ul className="me-alert-set-rows">
        {email && data.emailAddress && (
          <li className="me-alert-set-row">
            <span className="me-alert-set-label"><b>{t("alertSettings.address")}</b><span>{t("alertSettings.addressVerified", { address: data.emailAddress })}</span></span>
          </li>
        )}
        {ROWS.map((row) => {
          const key = row.key;
          return (
            <li className="me-alert-set-row" key={row.label}>
              <span className="me-alert-set-label"><b>{t(row.label)}</b>{row.note && <span>{t(row.note)}</span>}</span>
              {!email || !key ? <span className="me-alert-set-site">{key ? t("alertSettings.siteOn") : t("alertSettings.siteOnly")}</span> : (
                <span className="me-alert-set-seg" role="group" aria-label={t("alertSettings.modeGroup", { label: t(row.label) })}>
                  {(EMAIL_SETTING_CHOICES[key] as readonly EmailMode[]).map((mode) => (
                    <button key={mode} type="button" aria-pressed={settings[key] === mode}
                      onClick={() => { if (settings[key] !== mode) void save({ [key]: mode }); }}>
                      {t(`alertSettings.mode.${mode}`)}
                    </button>
                  ))}
                </span>
              )}
            </li>
          );
        })}
        {email && (
          <li className="me-alert-set-row">
            <span className="me-alert-set-label"><b>{t("alertSettings.digest")}</b>
              <span>{t("alertSettings.digestValue", { weekday: weekdayLabel(settings.digestWeekday), hour: hourLabel(settings.digestHour) })}</span></span>
            {digest ? (
              <span className="me-alert-set-digest">
                <label><span className="sr-only">{t("alertSettings.weekdayLabel")}</span>
                  <select value={digest.weekday} onChange={(event) => setDigest({ ...digest, weekday: Number(event.target.value) })}>
                    {WEEKDAYS.map((day) => <option key={day} value={day}>{weekdayLabel(day)}</option>)}
                  </select>
                </label>
                <label><span className="sr-only">{t("alertSettings.hourLabel")}</span>
                  <select value={digest.hour} onChange={(event) => setDigest({ ...digest, hour: Number(event.target.value) })}>
                    {HOURS.map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
                  </select>
                </label>
                <button type="button" className="me-alert-set-btn pri" onClick={() => { void save({ digestWeekday: digest.weekday, digestHour: digest.hour }); setDigest(null); }}>{t("alertSettings.save")}</button>
                <button type="button" className="me-alert-set-btn ghost" onClick={() => setDigest(null)}>{t("alertSettings.cancel")}</button>
              </span>
            ) : (
              <button type="button" className="me-alert-set-btn" onClick={() => setDigest({ weekday: settings.digestWeekday, hour: settings.digestHour })}>{t("alertSettings.change")}</button>
            )}
          </li>
        )}
        {email && (
          <li className="me-alert-set-row">
            <span className="me-alert-set-label"><b>{t("alertSettings.news")}</b><span>{t("alertSettings.newsNote")}</span></span>
            <button type="button" role="switch" className="me-alert-set-switch" aria-checked={settings.newsOptIn} aria-label={t("alertSettings.news")}
              onClick={() => void save({ newsOptIn: !settings.newsOptIn })} />
          </li>
        )}
      </ul>
      {email && <p className="me-alert-set-hint">{t("alertSettings.hint")}</p>}
      <p className="me-alert-set-status" role="status">{status ? t(status) : ""}</p>
    </section>
  );
}
