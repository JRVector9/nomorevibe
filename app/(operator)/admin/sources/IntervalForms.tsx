"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { intervalText, JOB_INTERVAL_MAX_MS, JOB_INTERVAL_MIN_MS } from "@/lib/jobs/job-intervals";
import { FEED_INTERVAL_MAX_MINUTES, FEED_INTERVAL_MIN_MINUTES, type FeedSourceConfig } from "@/lib/crawl/feed-source-schema";
import { saveFeedSourceAction, saveJobIntervalAction } from "./actions";

type Message = { text: string; tone: "ok" | "bad" };
const Messages = ({ list }: { list: Message[] }) => <>{list.map(message =>
  <p key={message.text} role={message.tone === "bad" ? "alert" : "status"} className="sc-msg">{message.text}</p>)}</>;

/**
 * 잡 주기 바꾸기(조각 4a) — 고치기 → 저장 전 확인(전 → 후, 코드 기본값과의 차이) → 기존 운영 설정 저장(saveJobIntervalAction → saveRuntimeSettings, 감사 runtime-settings-save).
 * 주기는 분 단위 1~1,440. 「코드 기본값으로」는 덮어쓰기를 지운다. scheduler 가 30초 안에 읽는다.
 */
export function JobIntervalForm({ job, label, currentMs, defaultMs, overridden, revision, readOnly, note }: { job: string; label: string; currentMs: number | null;
  defaultMs: number | null; overridden: boolean; revision: number | null; readOnly: boolean; note?: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [minutes, setMinutes] = useState(currentMs ? String(Math.round(currentMs / 60_000)) : "");
  const [reset, setReset] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, start] = useTransition();
  if (defaultMs === null) return <p className="sc-hint">요청될 때만 도는 작업이라 주기가 없습니다.</p>;
  if (readOnly || revision === null) return <p className="sc-hint">{readOnly ? "읽기 전용 화면입니다." : "운영 설정을 읽지 못해 바꿀 수 없습니다."}</p>;
  const afterMs = reset ? defaultMs : Number(minutes) * 60_000;
  const review = () => {
    const next: string[] = [];
    if (!reset && (!/^\d{1,4}$/.test(minutes.trim()) || afterMs < JOB_INTERVAL_MIN_MS || afterMs > JOB_INTERVAL_MAX_MS))
      next.push(`주기는 ${JOB_INTERVAL_MIN_MS / 60_000}~${JOB_INTERVAL_MAX_MS / 60_000}분 사이의 정수 분입니다.`);
    else if (afterMs === currentMs && (!reset || !overridden)) next.push("바뀐 값이 없습니다.");
    setIssues(next);
    if (!next.length) setMode("confirm");
  };
  const apply = () => start(async () => {
    const form = new FormData();
    form.set("job", job); form.set("expectedRevision", String(revision));
    if (reset) form.set("reset", "on"); else form.set("minutes", minutes.trim());
    const result = await saveJobIntervalAction(null, form);
    if (!result?.ok) { setMessages((result?.issues ?? ["저장 결과를 확인하지 못했습니다."]).map(text => ({ text, tone: "bad" as const }))); return; }
    setMessages([{ text: result.message ?? "저장했습니다.", tone: "ok" }]); setMode("view"); setReset(false);
    router.refresh();
  });
  const cancel = () => { setMode("view"); setIssues([]); setReset(false); setMinutes(currentMs ? String(Math.round(currentMs / 60_000)) : ""); };
  return <div className="sc-form" data-dirty={mode !== "view" ? "true" : undefined}>
    {mode === "view" && <div className="sc-acts"><button type="button" className="button small" onClick={() => { setMessages([]); setMode("edit"); }}>주기 바꾸기</button>
      <span className="sc-hint">지금 {intervalText(currentMs)}{overridden ? ` · 코드 기본값 ${intervalText(defaultMs)}` : " · 코드 기본값"}</span></div>}
    {mode === "edit" && <form className="sc-form" onSubmit={event => { event.preventDefault(); review(); }}>
      <label><span>{label} 주기(분)</span><input className="num" type="number" min={1} max={1440} step={1} value={minutes} disabled={reset}
        onChange={event => setMinutes(event.target.value)} aria-label={`${label} 주기(분)`} /></label>
      {overridden && <label className="sc-check"><input type="checkbox" checked={reset} onChange={event => setReset(event.target.checked)} />
        <span>코드 기본값({intervalText(defaultMs)})으로 되돌리기</span></label>}
      {note && <p className="sc-hint">{note}</p>}
      <div className="sc-acts"><button type="submit" className="button small primary">저장 전 확인</button>
        <button type="button" className="button small" onClick={cancel}>그만두기</button></div>
    </form>}
    {mode === "confirm" && <div className="sc-dlg" role="group" aria-label="저장 전 확인">
      <h4>{label} 주기를 바꿉니다</h4>
      <ul className="sc-diff">
        <li><span>주기</span><span><s>{intervalText(currentMs)}</s>{intervalText(afterMs)}{reset ? " (코드 기본값)" : ""}</span></li>
        <li><span>적용</span><span>{afterMs < (currentMs ?? afterMs)
          ? "scheduler 가 30초 안에 읽고, 잡힌 예약이 새 주기보다 멀면 곧 한 번 돌린 뒤 새 주기로 다시 잡습니다."
          : reset ? "scheduler 가 30초 안에 읽습니다. 이미 잡힌 다음 예약까지는 기다린 뒤 기본 주기로 돕니다."
            : "scheduler 가 30초 안에 읽고, 이미 잡힌 다음 예약 뒤부터 새 주기로 잡습니다."}</span></li>
        <li><span>기록</span><span>작업 로그에 「실시간 한도 저장」(전 → 후)으로 남고, 홈의 「바꾼 것 지켜보기」에 뜹니다.</span></li>
      </ul>
      {!reset && afterMs < defaultMs && <p className="sc-msg" data-warn="true">코드 기본값({intervalText(defaultMs)})보다 짧습니다 — 외부 요청과 DB 일이 그만큼 늘어납니다.</p>}
      {note && <p className="sc-hint">{note}</p>}
      <div className="sc-acts"><button type="button" className="button small primary" disabled={pending} onClick={apply}>{pending ? "저장 중…" : "바꾸기"}</button>
        <button type="button" className="button small" disabled={pending} onClick={cancel}>취소</button></div>
    </div>}
    {issues.map(text => <p key={text} role="alert" className="sc-msg">{text}</p>)}
    <Messages list={messages} />
  </div>;
}

/**
 * 화면에서 더한 글 목록 수집원의 주기·켜고 끄기(조각 4a) — 저장 전 확인을 거쳐 기존과 같은 수집원 저장(saveFeedSourceAction, 화면이 본 값 compare-and-set, 감사 crawl-source-save).
 * 끄기·켜기는 사유를 받는다(작업 로그에 남는다). 글 목록 작업 전체를 멈추는 것은 「잠시 멈춤」(작업 멈춤)이다.
 */
export function FeedSettingsForm({ feed, jobIntervalMs, readOnly }: { feed: FeedSourceConfig; jobIntervalMs: number | null; readOnly: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [minutes, setMinutes] = useState(String(feed.intervalMinutes));
  const [enabled, setEnabled] = useState(feed.enabled);
  const [reason, setReason] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, start] = useTransition();
  if (readOnly) return <p className="sc-hint">읽기 전용 화면입니다.</p>;
  const nextMinutes = Number(minutes);
  const review = (nextEnabled: boolean) => {
    const next: string[] = [];
    if (!/^\d{1,4}$/.test(minutes.trim()) || nextMinutes < FEED_INTERVAL_MIN_MINUTES || nextMinutes > FEED_INTERVAL_MAX_MINUTES)
      next.push(`주기는 ${FEED_INTERVAL_MIN_MINUTES}~${FEED_INTERVAL_MAX_MINUTES}분 사이의 정수 분입니다.`);
    else if (nextMinutes === feed.intervalMinutes && nextEnabled === feed.enabled) next.push("바뀐 값이 없습니다.");
    setIssues(next); setEnabled(nextEnabled);
    if (!next.length) setMode("confirm");
  };
  const apply = () => start(async () => {
    const form = new FormData();
    const next = { ...feed, intervalMinutes: nextMinutes, enabled };
    form.set("id", next.id); form.set("name", next.name); form.set("url", next.url); form.set("titlePrefix", next.titlePrefix);
    form.set("linkKind", next.link.kind);
    if (next.link.kind === "page-title") { form.set("titleClass", next.link.titleClass); form.set("linkClass", next.link.linkClass); form.set("bodyId", next.link.bodyId ?? ""); }
    form.set("intervalMinutes", String(next.intervalMinutes)); form.set("priority", String(next.priority));
    if (next.enabled) form.set("enabled", "on");
    if (next.requireEvidence) form.set("requireEvidence", "on");
    form.set("expected", JSON.stringify(feed)); form.set("reason", reason);
    const result = await saveFeedSourceAction(null, form);
    if (!result?.ok) { setMessages((result?.issues ?? ["저장 결과를 확인하지 못했습니다."]).map(text => ({ text, tone: "bad" as const }))); return; }
    setMessages([{ text: result.message ?? "저장했습니다.", tone: "ok" }]); setMode("view"); setReason("");
    router.refresh();
  });
  const cancel = () => { setMode("view"); setIssues([]); setMinutes(String(feed.intervalMinutes)); setEnabled(feed.enabled); setReason(""); };
  const toggling = enabled !== feed.enabled;
  return <div className="sc-form" data-dirty={mode !== "view" ? "true" : undefined}>
    {mode === "view" && <div className="sc-acts">
      <button type="button" className="button small" onClick={() => { setMessages([]); setMode("edit"); }}>주기 바꾸기</button>
      <button type="button" className="button small" onClick={() => { setMessages([]); review(!feed.enabled); }}>{feed.enabled ? "이 수집원 끄기" : "이 수집원 켜기"}</button>
    </div>}
    {mode === "edit" && <form className="sc-form" onSubmit={event => { event.preventDefault(); review(feed.enabled); }}>
      <label><span>주기(분)</span><input className="num" type="number" min={FEED_INTERVAL_MIN_MINUTES} max={FEED_INTERVAL_MAX_MINUTES} step={1} value={minutes}
        onChange={event => setMinutes(event.target.value)} aria-label={`${feed.name} 주기(분)`} /></label>
      <p className="sc-hint">글 목록 작업은 {intervalText(jobIntervalMs)}마다 돕니다 — 그보다 짧게 적으면 작업이 돌 때마다 읽습니다.</p>
      <div className="sc-acts"><button type="submit" className="button small primary">저장 전 확인</button>
        <button type="button" className="button small" onClick={cancel}>그만두기</button></div>
    </form>}
    {mode === "confirm" && <div className="sc-dlg" role="group" aria-label="저장 전 확인">
      <h4>{toggling ? `「${feed.name}」을 ${enabled ? "켭니다" : "끕니다"}` : `「${feed.name}」 주기를 바꿉니다`}</h4>
      <ul className="sc-diff">
        {nextMinutes !== feed.intervalMinutes && <li><span>주기</span><span><s>{intervalText(feed.intervalMinutes * 60_000)}</s>{intervalText(nextMinutes * 60_000)}</span></li>}
        {toggling && <li><span>상태</span><span><s>{feed.enabled ? "켜짐" : "꺼짐"}</s>{enabled ? "켜짐" : "꺼짐"}</span></li>}
        <li><span>적용</span><span>글 목록 작업의 다음 회차부터 씁니다. 다른 수집원과 검색 신호는 그대로입니다.</span></li>
      </ul>
      <label className="sc-form"><span className="sc-hint">사유{toggling ? "" : "(선택)"}</span>
        <input type="text" maxLength={500} value={reason} onChange={event => setReason(event.target.value)} aria-label="사유" /></label>
      <div className="sc-acts"><button type="button" className="button small primary" disabled={pending || (toggling && !reason.trim())} onClick={apply}>
        {pending ? "저장 중…" : toggling ? (enabled ? "켜기" : "끄기") : "바꾸기"}</button>
        <button type="button" className="button small" disabled={pending} onClick={cancel}>취소</button></div>
    </div>}
    {issues.map(text => <p key={text} role="alert" className="sc-msg">{text}</p>)}
    <Messages list={messages} />
  </div>;
}
