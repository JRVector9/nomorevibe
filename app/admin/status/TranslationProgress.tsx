import type { TranslationProgress as Progress } from "@/lib/crawl/translations";
import { formatAgo } from "@/lib/format/time";
import { TranslationFailures } from "./TranslationFailures";

/** 30분 넘게 한 건도 옮기지 못했는데 남은 것이 있으면 멈춘 것으로 본다 — 틱은 1분마다다 */
const STALL_SECONDS = 30 * 60;

/** 마지막으로 옮긴 때 — 집계 시각(measuredAt)에서 lastSecondsAgo 를 뺀 시각을 화면 기준 시각(now)과 견준다 */
function ago(progress: Progress, now: string): string {
  if (progress.lastSecondsAgo === null) return "아직 없음";
  return formatAgo(Date.parse(progress.measuredAt) - progress.lastSecondsAgo * 1000, now);
}

/**
 * 사유 번역 — 심사 화면의 영어 사유를 미리 한국어로 옮기는 진행.
 * 느려도 매 틱 조금씩 이어 가므로 "얼마나 남았고, 지금도 움직이는가"를 한 줄로 보인다.
 */
export function TranslationProgress({ progress, now }: { progress: Progress; now: string }) {
  const percent = progress.total ? Math.floor((progress.done / progress.total) * 100) : 100;
  const stalled = progress.pending > 0 && (progress.lastSecondsAgo === null || progress.lastSecondsAgo > STALL_SECONDS) && progress.lastHour === 0;
  /** 막 옮긴 것이 있으면 막대가 흐른다 — 숫자만으로는 멈춘 것과 느린 것이 같아 보인다 */
  const moving = progress.pending > 0 && progress.lastSecondsAgo !== null && progress.lastSecondsAgo < 180;
  // 진행률은 1분 담아 둔 값이다(translations.ts) — 화면을 그린 시각(now) 기준으로 몇 초 전에 센 것인지 밝힌다
  const measuredAgo = Math.max(0, Math.round((Date.parse(now) - Date.parse(progress.measuredAt)) / 1000));
  return (
    <section aria-label="사유 번역" className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[12px] border border-line bg-bg-card px-3 py-2 text-[13px]">
      <p className="font-semibold text-fg-3">사유 번역 <span className="font-mono font-normal">gpt-oss-120b</span></p>
      <div className="h-1.5 min-w-[120px] flex-1 overflow-hidden rounded-full bg-bg-soft" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full ${stalled ? "bg-warn" : "bg-accent"}${moving ? " ops-progress-live" : ""}`} style={{ width: `${percent}%` }} />
      </div>
      <div className="font-mono tabular-nums text-fg-2">
        {progress.done.toLocaleString("ko-KR")}/{progress.total.toLocaleString("ko-KR")} ({percent}%)
        <div className="inline text-fg-3"> · 남음 {progress.pending.toLocaleString("ko-KR")} · <TranslationFailures failed={progress.failed} failures={progress.failures} /> · 최근 1시간 {progress.lastHour.toLocaleString("ko-KR")}건 · 마지막 {ago(progress, now)}{measuredAgo >= 5 && ` · ${measuredAgo}초 전 집계`}</div>
      </div>
      {stalled && <p className="w-full text-warn">30분 넘게 옮긴 것이 없습니다 — <span className="font-mono">reason-translate</span> 작업과 ABCLLM_API_KEY 를 확인하세요.</p>}
    </section>
  );
}
