"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { FeedPreview } from "@/lib/crawl/feed-preview";
import { FEED_INTERVAL_MAX_MINUTES, FEED_INTERVAL_MIN_MINUTES, type FeedLinkRule } from "@/lib/crawl/feed-source-schema";
import { intervalText } from "@/lib/jobs/job-intervals";
import { previewFeedSourceAction, saveFeedSourceAction } from "../actions";
import "../sources.css";

export type FeedAddKind = "feed";
type Draft = { name: string; url: string; titlePrefix: string; linkKind: FeedLinkRule["kind"]; titleClass: string; linkClass: string; bodyId: string;
  intervalMinutes: string; priority: string; requireEvidence: boolean };
const EMPTY: Draft = { name: "", url: "", titlePrefix: "", linkKind: "page-title", titleClass: "", linkClass: "", bodyId: "", intervalMinutes: "30", priority: "120",
  requireEvidence: false };
const INTERVALS = [10, 30, 60, 120, 360, 720, 1440] as const;
const REASONS: Record<string, string> = { unsafe_url: "열 수 없는 주소입니다(내부망·사용자 정보가 든 주소는 읽지 않습니다).", timeout: "10초 안에 답이 없습니다.",
  too_large: "피드가 너무 큽니다(512KB 상한).", invalid_feed: "RSS·Atom 피드로 읽지 못했습니다.", feed_entries_limit: "글이 200개를 넘는 피드는 잘린 것으로 보고 읽지 않습니다.",
  invalid_topic_id: "글 번호를 읽지 못했습니다.", invalid_input: "주소와 규칙을 확인해 주세요.", unauthorized: "다시 로그인해 주세요.", preview_failed: "미리 보기를 하지 못했습니다." };
const reasonText = (reason: string) => REASONS[reason] ?? (reason.startsWith("http_") ? `피드가 HTTP ${reason.slice(5)}로 답했습니다.` : reason);

const link = (draft: Draft): FeedLinkRule => draft.linkKind === "entry-link" ? { kind: "entry-link" }
  : { kind: "page-title", titleClass: draft.titleClass.trim(), linkClass: draft.linkClass.trim(), bodyId: draft.bodyId.trim() || null };

/**
 * 수집원 추가 세 걸음(2026-11-12 최종 시안 흐름 4, 조각 4a) — ① 종류 ② 주소와 규칙 ③ 미리 보고 켜기(저장 전 확인).
 * 「글 목록(RSS·Atom)」만 화면에서 끝까지 된다: 미리 보기는 주소를 한 번 읽어 세기만 하고(쓰지 않음), 켜기는 크롤 설정의 글 목록 수집원 한 줄을 더한다
 * (saveFeedSourceAction — 감사 crawl-source-save). GitHub 검색어는 기존 수집 설정 화면으로 잇고, 사이트 목록·그 밖의 API 는 아직 코드가 없다(개발 필요).
 */
export function FeedSourceAdd({ kind, taken, jobIntervalMs, readOnly }: { kind: FeedAddKind | null; taken: readonly string[]; jobIntervalMs: number | null; readOnly: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(kind === "feed" ? 2 : 1);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [preview, setPreview] = useState<FeedPreview | null>(null);
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const [reason, setReason] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const set = (patch: Partial<Draft>) => { setDraft(current => ({ ...current, ...patch })); setPreview(null); setConfirming(null); };
  const nameTaken = taken.some(name => name.trim().toLowerCase() === draft.name.trim().toLowerCase());

  const check = (): string[] => {
    const out: string[] = [];
    if (!draft.name.trim()) out.push("이름을 적어 주세요(수집 신호 이름이 됩니다).");
    else if (nameTaken) out.push(`「${draft.name.trim()}」은 이미 쓰는 신호 이름입니다.`);
    if (!/^https?:\/\//i.test(draft.url.trim())) out.push("피드 주소를 http(s) 로 적어 주세요.");
    if (draft.linkKind === "page-title" && (!draft.titleClass.trim() || !draft.linkClass.trim())) out.push("제목 영역 class 와 제목 링크 class 를 적어 주세요.");
    const minutes = Number(draft.intervalMinutes);
    if (!Number.isInteger(minutes) || minutes < FEED_INTERVAL_MIN_MINUTES || minutes > FEED_INTERVAL_MAX_MINUTES) out.push("주기를 골라 주세요.");
    const priority = Number(draft.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 1000) out.push("우선순위는 0~1000 의 정수입니다.");
    return out;
  };
  const runPreview = () => {
    const found = check();
    setIssues(found);
    if (found.length) return;
    start(async () => {
      const result = await previewFeedSourceAction({ url: draft.url.trim(), titlePrefix: draft.titlePrefix.trim(), link: link(draft) });
      setPreview(result); setStep(3);
    });
  };
  const save = (enabled: boolean) => start(async () => {
    const form = new FormData();
    form.set("name", draft.name.trim()); form.set("url", draft.url.trim()); form.set("titlePrefix", draft.titlePrefix.trim()); form.set("linkKind", draft.linkKind);
    form.set("titleClass", draft.titleClass.trim()); form.set("linkClass", draft.linkClass.trim()); form.set("bodyId", draft.bodyId.trim());
    form.set("intervalMinutes", draft.intervalMinutes); form.set("priority", draft.priority);
    if (enabled) form.set("enabled", "on");
    if (draft.requireEvidence) form.set("requireEvidence", "on");
    form.set("reason", reason);
    const result = await saveFeedSourceAction(null, form);
    if (!result?.ok) { setIssues(result?.issues ?? ["저장 결과를 확인하지 못했습니다. 새로고침해 상태를 확인하세요."]); return; }
    router.push(`/admin/sources?source=${encodeURIComponent(`feed-${result.id}`)}#source-detail`);
    router.refresh();
  });

  return <div className="sources-console" data-dirty={step > 1 ? "true" : undefined}>
    <div className="sc-head"><h2>수집원 추가</h2><span className="sc-right"><Link prefetch={false} className="text-button" href="/admin/sources">수집원 목록으로</Link></span></div>
    <ol className="sc-steps" aria-label="걸음">
      {(["종류", "주소와 규칙", "미리 보고 켜기"] as const).map((label, index) => <li key={label} aria-current={step === index + 1 ? "step" : undefined}><b>{index + 1}</b>{label}</li>)}
    </ol>
    {readOnly && <p className="sc-notice">읽기 전용 화면입니다 — 미리 보기와 저장을 할 수 없습니다.</p>}

    {step === 1 && <section className="sc-card" aria-label="종류">
      <ul className="sc-pick">
        <li><button type="button" onClick={() => setStep(2)}><span>글 목록(RSS·Atom)</span><span>화면에서</span></button></li>
        <li><Link prefetch={false} href="/admin#signals"><span>GitHub 검색어</span><span>수집 설정 화면에서</span></Link></li>
        <li data-off="true"><div><span>사이트 목록</span><span>개발 필요</span></div></li>
        <li data-off="true"><div><span>그 밖의 API</span><span>개발 필요</span></div></li>
      </ul>
      <p className="sc-hint">GitHub 검색어는 크롤 설정의 검색 신호에서 더합니다 — 저장하면 GitHub 검색 주기가 처음부터 다시 돕니다(1~2시간 발견이 멈출 수 있음).
        사이트 목록·그 밖의 API 는 받는 코드가 아직 없어 이 화면에서 더할 수 없습니다.</p>
    </section>}

    {step >= 2 && <section className="sc-card" aria-label="주소와 규칙">
      <form className="sc-form" onSubmit={event => { event.preventDefault(); runPreview(); }}>
        <label><span>이름</span><input type="text" value={draft.name} maxLength={40} onChange={event => set({ name: event.target.value })} placeholder="예: Show GN"
          autoComplete="off" aria-invalid={nameTaken || undefined} /></label>
        <label><span>피드 주소</span><input type="url" value={draft.url} maxLength={500} onChange={event => set({ url: event.target.value })}
          placeholder="https://news.hada.io/rss/news" autoComplete="off" /></label>
        <label><span>고를 글</span><input type="text" value={draft.titlePrefix} maxLength={40} onChange={event => set({ titlePrefix: event.target.value })}
          placeholder="제목이 이 말로 시작 — 예: Show GN:" autoComplete="off" /></label>
        <fieldset><legend>제품 링크를 찾는 방법</legend>
          <label className="sc-check"><input type="radio" name="linkKind" checked={draft.linkKind === "page-title"} onChange={() => set({ linkKind: "page-title" })} />
            <span>글 페이지의 제목 링크 — 글을 열어 제목 영역의 링크를 읽습니다(피드와 같은 사이트의 글만)</span></label>
          {draft.linkKind === "page-title" && <>
            <label><span>제목 영역 class</span><input type="text" value={draft.titleClass} maxLength={80} onChange={event => set({ titleClass: event.target.value })}
              placeholder="topictitle link" autoComplete="off" /></label>
            <label><span>제목 링크 class</span><input type="text" value={draft.linkClass} maxLength={80} onChange={event => set({ linkClass: event.target.value })}
              placeholder="topic-title-link" autoComplete="off" /></label>
            <label><span>본문 id</span><input type="text" value={draft.bodyId} maxLength={64} onChange={event => set({ bodyId: event.target.value })}
              placeholder="topic_contents (없으면 비움)" autoComplete="off" /></label>
          </>}
          <label className="sc-check"><input type="radio" name="linkKind" checked={draft.linkKind === "entry-link"} onChange={() => set({ linkKind: "entry-link" })} />
            <span>피드 항목의 링크 — 항목의 링크가 곧 제품(GitHub 저장소나 사이트)입니다</span></label>
        </fieldset>
        <label><span>주기</span><select value={draft.intervalMinutes} onChange={event => set({ intervalMinutes: event.target.value })}>
          {INTERVALS.map(minutes => <option key={minutes} value={minutes}>{intervalText(minutes * 60_000)}</option>)}</select></label>
        <label><span>우선순위</span><input className="num" type="number" min={0} max={1000} step={1} value={draft.priority} onChange={event => set({ priority: event.target.value })} /></label>
        <label className="sc-check"><input type="checkbox" checked={draft.requireEvidence} onChange={event => set({ requireEvidence: event.target.checked })} />
          <span>AI 코딩 흔적이 있는 저장소만 받기(글 목록 자체는 AI 제작 근거가 아닙니다)</span></label>
        <p className="sc-hint">글 목록 작업은 {intervalText(jobIntervalMs)}마다 돕니다 — 주기를 그보다 짧게 고르면 작업이 돌 때마다 읽습니다. GeekNews Show GN 의 규칙은 제목 「Show GN:」, 제목 영역 class
          「topictitle link」, 제목 링크 class 「topic-title-link」, 본문 id 「topic_contents」입니다.</p>
        <div className="sc-acts"><button type="submit" className="button small primary" disabled={pending || readOnly}>{pending && step === 2 ? "읽는 중…" : "미리 보기"}</button>
          <button type="button" className="button small" onClick={() => { setStep(1); setPreview(null); setIssues([]); }}>종류로</button></div>
      </form>
    </section>}

    {step === 3 && preview && <section className="sc-card" aria-label="미리 보고 켜기">
      {!preview.ok ? <p role="alert" className="sc-msg">{reasonText(preview.reason)}</p> : <>
        <dl className="sc-dl">
          <dt>읽은 범위</dt><dd className="num">{preview.spanHours === null ? "" : `${preview.spanHours.toFixed(1)}시간 · `}글 {preview.entries}개</dd>
          <dt>고른 글</dt><dd className="num">{preview.selected}개{preview.perDay !== null ? ` (하루 약 ${preview.perDay.toFixed(preview.perDay < 10 ? 1 : 0)}개)` : ""}
            {preview.skipped ? <span className="sc-muted"> · 주소 없음·다른 사이트 {preview.skipped}개 건너뜀</span> : null}</dd>
          <dt>저장소</dt><dd className="num">{preview.repos}개 → 심사 줄로</dd>
          <dt>사이트만</dt><dd className="num">{preview.siteOnly}개 → 받지 않음(받는 경로 필요)</dd>
          {preview.failed > 0 && <><dt>읽지 못함</dt><dd className="num">{preview.failed}개 — 수집 때 다음 회차에 다시 읽습니다</dd></>}
        </dl>
        {preview.unchecked > 0 && <p className="sc-hint">글 페이지는 최근 {preview.checked}개만 읽었습니다(나머지 {preview.unchecked}개는 켠 뒤 수집 작업이 읽습니다).</p>}
        {preview.samples.length > 0 && <ul className="sc-samples">{preview.samples.map(sample => <li key={sample.page}><span>{sample.title || sample.page}</span>
          <span className="sc-muted"> — {sample.state === "repo" ? sample.repo : sample.state === "site" ? "사이트만" : "읽지 못함"}</span></li>)}</ul>}
        {confirming === null ? <div className="sc-acts">
          <button type="button" className="button small primary" disabled={readOnly || pending} onClick={() => setConfirming(true)}>켜기</button>
          <button type="button" className="button small" disabled={readOnly || pending} onClick={() => setConfirming(false)}>꺼 둔 채 저장</button>
        </div> : <div className="sc-dlg" role="group" aria-label="저장 전 확인">
          <h4>수집원 「{draft.name.trim()}」을 {confirming ? "켭니다" : "꺼 둔 채 넣습니다"}</h4>
          <ul className="sc-diff">
            <li><span>주소</span><span className="sc-num">{draft.url.trim()}</span></li>
            <li><span>고를 글</span><span>{draft.titlePrefix.trim() ? `제목이 「${draft.titlePrefix.trim()}」으로 시작` : "모든 글"}</span></li>
            <li><span>제품 링크</span><span>{draft.linkKind === "page-title" ? `글 페이지의 제목 링크(${draft.titleClass.trim()} › ${draft.linkClass.trim()})` : "피드 항목의 링크"}</span></li>
            <li><span>주기 · 우선순위</span><span>{intervalText(Number(draft.intervalMinutes) * 60_000)} · {draft.priority}</span></li>
            {confirming && <li><span>처음 읽을 때</span><span>지금 피드의 고른 글 {preview.selected}개를 한 번에 읽습니다(한 회차 20개까지, 남은 것은 다음 회차).</span></li>}
            <li><span>그대로인 것</span><span>Show GN·Show HN·GitHub 검색어와 그 주기 — 검색 주기는 처음부터 다시 돌지 않습니다.</span></li>
            <li><span>기록</span><span>작업 로그에 「수집원 추가·고침」으로 남고 홈의 「바꾼 것 지켜보기」에 뜹니다.</span></li>
          </ul>
          <label className="sc-form"><span className="sc-hint">사유(선택)</span><input type="text" maxLength={500} value={reason} onChange={event => setReason(event.target.value)}
            aria-label="사유" /></label>
          <div className="sc-acts"><button type="button" className="button small primary" disabled={pending || readOnly} onClick={() => save(confirming)}>
            {pending ? "저장 중…" : confirming ? "켜기" : "저장"}</button>
            <button type="button" className="button small" disabled={pending} onClick={() => setConfirming(null)}>취소</button></div>
        </div>}
      </>}
    </section>}
    {issues.map(text => <p key={text} role="alert" className="sc-msg">{text}</p>)}
  </div>;
}
