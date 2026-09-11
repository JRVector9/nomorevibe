import type { TranslationProgress as Progress } from "@/lib/crawl/translations";

/** 30분 넘게 한 건도 옮기지 못했는데 남은 것이 있으면 멈춘 것으로 본다 — 틱은 1분마다다 */
const STALL_SECONDS = 30 * 60;

function ago(seconds: number | null): string {
  if (seconds === null) return "아직 없음";
  if (seconds < 90) return "방금";
  if (seconds < 3_600) return `${Math.round(seconds / 60)}분 전`;
  return `${Math.round(seconds / 3_600)}시간 전`;
}

/**
 * 사유 번역 — 심사 화면의 영어 사유를 미리 한국어로 옮기는 진행.
 * 느려도 매 틱 조금씩 이어 가므로 "얼마나 남았고, 지금도 움직이는가"를 한 줄로 보인다.
 */
export function TranslationProgress({ progress }: { progress: Progress }) {
  const percent = progress.total ? Math.floor((progress.done / progress.total) * 100) : 100;
  const stalled = progress.pending > 0 && (progress.lastSecondsAgo === null || progress.lastSecondsAgo > STALL_SECONDS) && progress.lastHour === 0;
  return (
    <section aria-label="사유 번역" className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[12px] border border-line bg-bg-card px-3 py-2 text-[13px]">
      <p className="font-semibold text-fg-3">사유 번역 <span className="font-mono font-normal">gpt-oss-120b</span></p>
      <div className="h-1.5 min-w-[120px] flex-1 overflow-hidden rounded-full bg-bg-soft" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full ${stalled ? "bg-warn" : "bg-accent"}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="font-mono tabular-nums text-fg-2">
        {progress.done.toLocaleString("ko-KR")}/{progress.total.toLocaleString("ko-KR")} ({percent}%)
        <span className="text-fg-3"> · 남음 {progress.pending.toLocaleString("ko-KR")} · 실패 {progress.failed.toLocaleString("ko-KR")} · 최근 1시간 {progress.lastHour.toLocaleString("ko-KR")}건 · 마지막 {ago(progress.lastSecondsAgo)}</span>
      </p>
      {stalled && <p className="w-full text-warn">30분 넘게 옮긴 것이 없습니다 — <span className="font-mono">reason-translate</span> 작업과 ABCLLM_API_KEY 를 확인하세요.</p>}
    </section>
  );
}
