import type { PipelineFlow } from "@/lib/operations/pipeline";

/**
 * 수집에서 공개까지의 흐름 — 한 줄.
 *
 * 적체 수만으로는 막힌 곳을 알 수 없다 — 100건이 쌓여도 하루 100건이 빠지면 막힌 것이
 * 아니고, 4건이 쌓여도 하루 0건이 빠지면 막힌 것이다. 단계마다 들어온 양과 빠진 양을
 * 함께 놓고, 빠진 것이 없는데 쌓여 있는 단계를 병목으로 짚는다.
 */
export function PipelineRail({ flow }: { flow: PipelineFlow }) {
  const bottleneck = flow.stages.find((stage) => stage.key === flow.bottleneck);

  return (
    <section aria-label="수집 → 공개" className="overflow-hidden rounded-[12px] border border-line bg-bg-card">
      <ol className="grid grid-cols-3 sm:grid-cols-6">
        {flow.stages.map((stage) => {
          const stuck = stage.key === flow.bottleneck;
          return (
            <li key={stage.key} title={stage.job ?? "사람이 처리"}
              className={`min-w-0 border-l border-line px-3 py-2 first:border-l-0 ${stuck ? "bg-down/5" : ""}`}>
              <p className={`truncate text-[13px] font-semibold ${stuck ? "text-down" : "text-fg-3"}`}>{stage.label}</p>
              <p className={`font-mono text-[19px] font-bold tabular-nums ${stuck ? "text-down" : ""}`}>
                {stage.waiting.toLocaleString("ko-KR")}
              </p>
              <p className="truncate text-[13px] text-fg-3">
                {stage.entered !== null && <span className="text-up">+{stage.entered.toLocaleString("ko-KR")}</span>}
                {stage.entered !== null && stage.left !== null && " / "}
                {stage.left !== null && <span>−{stage.left.toLocaleString("ko-KR")}</span>}
                {stage.entered === null && stage.left === null ? "누적" : " · 24h"}
              </p>
            </li>
          );
        })}
      </ol>
      <p className="border-t border-line bg-bg-soft px-3 py-1.5 text-[13px] text-fg-2">
        {bottleneck ? (
          <>병목 <b className="font-semibold text-down">{bottleneck.label}</b> — {bottleneck.waiting.toLocaleString("ko-KR")}건이 쌓였는데 24시간 동안 한 건도 빠지지 않았습니다{bottleneck.job ? <> · <span className="font-mono">{bottleneck.job}</span> 확인</> : " · 사람이 처리하는 단계"}.</>
        ) : (
          <>모든 단계에서 지난 24시간 동안 처리가 있었습니다. 멈춘 곳은 없습니다.</>
        )}
      </p>
    </section>
  );
}
