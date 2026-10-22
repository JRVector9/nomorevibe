import { formatListTime } from "@/lib/format/time";
import type { ScreenReviewStatus } from "@/lib/screen-review/job";
import { SCREEN_REVIEW_MAX_PER_TICK, type ScreenReviewSettings } from "@/lib/crawl/settings-schema";
import { AUTO_CLOSE_KEEP_DAYS, AUTO_CLOSE_MIN_CONFIDENCE } from "@/lib/crawl/audit-auto-close";
import { QwenAutoStepSwitch } from "../components/QwenAutoStepSwitch";

const count = (value: number) => value.toLocaleString("ko-KR");
const STAGE = { render: "화면 서버", model: "모델", input: "입력", write: "적기", config: "설정" } as const;

/**
 * 화면 판별(lib/screen-review/job.ts) — 글이 얇은(JS 로 그리는) 감사 거절을 화면 서버(m1-studio)로 그려 m1 Qwen 에 글+첫 화면으로 묻는다.
 * 켬/끔·틱당 수, 지난 1시간·24시간에 적은 수(그중 승인·거절), 남은 것, 화면 서버 상태(샌드박스·글꼴), 물러나기·마지막 오류
 */
export function ScreenReviewPanel({ status, value, now }: { status: ScreenReviewStatus; value: ScreenReviewSettings; now: Date }) {
  const at = (iso: string | null) => iso ? formatListTime(new Date(iso), now) : "—";
  const fonts = status.health?.fonts;
  const recovered = status.lastError && status.lastSuccessAt && status.lastSuccessAt > status.lastError.at;
  const backoff = [status.backoff.render && `화면 서버 ${at(status.backoff.render.until)}까지(${status.backoff.render.code ?? "탈"})`,
    status.backoff.model && `모델 ${at(status.backoff.model.until)}까지(${status.backoff.model.code ?? "탈"})`].filter(Boolean);
  return (
    <div className="flex flex-col gap-1 border-t border-line pt-3 text-[13px] tabular-nums text-fg-2" aria-label="화면 판별">
      <p><b className="font-semibold">화면 판별</b> <span className={`rounded px-1.5 py-0.5 font-semibold ${status.enabled ? "bg-accent-soft text-accent" : "bg-bg-soft text-fg-2"}`}>
        {status.enabled ? "켬" : "끔"}</span> 틱마다 {count(status.perTick)}건 · 화면 판별 대기(글 적음·원본 없음) ·
        지난 1시간 {count(status.lastHour)} · 24시간 {count(status.lastDay)}(승인 {count(status.approveDay)} · 거절 {count(status.rejectDay)}) ·
        남은 것 <b className="font-semibold">{count(status.remaining)}</b>(공개 중 {count(status.waitingPublic)})
        {status.givenUp > 0 && ` · 그려지지 않아 그만 본 것 ${count(status.givenUp)}건`}</p>
      <p className="text-fg-3">{status.configured ? <>화면 서버 {status.renderHost} · {status.model} · 글 {status.promptVersion}
        {status.shared ? " · 감사 두 번째 의견과 같은 모델 서버" : " · 따로 둔 모델 서버"}</> : "설정 없음 — SCREEN_RENDER_URL·SCREEN_RENDER_TOKEN(reviewer 앱)"}
        {status.health && <> · 서버 {status.health.ok ? "정상" : "그리지 않음"}{status.health.version && ` (판 ${status.health.version})`} ·
          샌드박스 {status.health.sandbox ? "켬" : "꺼짐"} · 글꼴 {fonts ? `한 ${fonts.ko ? "✓" : "✗"} 일 ${fonts.ja ? "✓" : "✗"} 중 ${fonts.zh ? "✓" : "✗"}` : "모름"}</>}
        {" "}· 마지막으로 돈 때 {at(status.lastRunAt)}</p>
      {backoff.length > 0 && <p className="text-warn">물러나는 중: {backoff.join(" · ")} — 화면 판별만 멈춥니다(글 단계는 그대로).</p>}
      {status.lastError && <p className={recovered ? "text-fg-3" : "text-warn"}>마지막 오류: <span className="font-mono">{status.lastError.code}</span> ·
        {" "}{STAGE[status.lastError.stage] ?? status.lastError.stage} · {at(status.lastError.at)}{recovered && ` — 그 뒤 ${at(status.lastSuccessAt)}에 다시 받음`}</p>}
      <QwenAutoStepSwitch key={`s:${JSON.stringify(value)}`} step="screenReview" value={value} title="화면 판별(m1 Qwen 화면+글)"
        maxPerTick={SCREEN_REVIEW_MAX_PER_TICK} toggles={[{ name: "autoClose", label: "답으로 닫기(승인 유지·보류 풀기, 거절 숨김)" }]}
        enableNotes={["화면 판별 대기(크롤러가 글을 읽지 못한 — 본문 300자 아래·원본 없음 — 열린 거절, 글만 본 판단으로 숨겨진 보류 중인 것 먼저)를 화면 서버(m1-studio, Chromium 샌드박스·사설망 차단)로 그려, 그린 뒤 글과 첫 화면을 m1 Qwen 에 묻습니다(출처 qwen-vision-auto).",
          value.autoClose ? `답으로 닫기가 켜져 있어 승인(확신 ${AUTO_CLOSE_MIN_CONFIDENCE.toFixed(2)} 이상)은 유지 ${AUTO_CLOSE_KEEP_DAYS}일, 주인 없는 제품의 거절은 숨깁니다 — 엇갈림은 화면을 본 의견끼리만 가르고 글만 본 의견은 세지 않습니다. 정책 처리 탭의 'm1 화면 자동 …' 실행으로 되돌립니다.`
            : "답으로 닫기가 꺼져 있어 의견만 적습니다(승인은 그 항목의 보류를 풀 수 있습니다).",
          "한 건에 그리기 수 초~40초와 묻기 12~90초가 걸립니다. 같은 m1 의 글 단계가 탈로 물러나면 함께 멈춥니다."]} />
    </div>
  );
}
