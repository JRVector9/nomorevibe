import type { PipelineFlow } from "@/lib/operations/pipeline";

/**
 * 수집에서 공개까지의 흐름.
 *
 * 적체 수만으로는 막힌 곳을 알 수 없다 — 100건이 쌓여도 하루 100건이 빠지면 막힌 것이
 * 아니고, 4건이 쌓여도 하루 0건이 빠지면 막힌 것이다. 단계마다 들어온 양과 빠진 양을
 * 함께 놓고, 빠진 것이 없는데 쌓여 있는 단계를 병목으로 짚는다.
 */
export function PipelineRail({ flow }: { flow: PipelineFlow }) {
  const bottleneck = flow.stages.find((stage) => stage.key === flow.bottleneck);

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[17px] font-bold">수집 → 공개</h2>
        <p className="text-[13px] text-fg-3">각 단계의 적체와 지난 24시간의 유입·유출입니다.</p>
      </div>

      <div className="mt-3 overflow-hidden rounded-[12px] border border-line bg-bg-card">
        {/* 셀마다 위·왼쪽 선을 두고 격자를 1px 당겨, 바깥 테두리와 겹치는 줄만 가린다 */}
        <div className="-ml-px -mt-px grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          {flow.stages.map((stage, index) => {
            const stuck = stage.key === flow.bottleneck;
            return (
              <div key={stage.key}
                className={`border-l border-t border-line p-4 ${stuck ? "bg-down/5" : ""}`}>
                <p className="font-mono text-[13px] text-fg-3">단계 {index + 1}</p>
                <h3 className={`mt-1 text-[13.5px] font-bold ${stuck ? "text-down" : ""}`}>{stage.label}</h3>
                <p className={`mt-1.5 font-mono text-[26px] font-bold tabular-nums ${stuck ? "text-down" : ""}`}>
                  {stage.waiting.toLocaleString("ko-KR")}
                </p>
                <p className="mt-1 text-[13px] text-fg-3">
                  {stage.entered !== null && <span className="text-up">+{stage.entered.toLocaleString("ko-KR")}</span>}
                  {stage.entered !== null && stage.left !== null && " / "}
                  {stage.left !== null && <span>−{stage.left.toLocaleString("ko-KR")}</span>}
                  {(stage.entered !== null || stage.left !== null) && " · 24시간"}
                  {stage.entered === null && stage.left === null && "누적"}
                </p>
                <p className="mt-2.5 border-t border-line pt-2 font-mono text-[13px] text-fg-3">
                  {stage.job ?? "사람이 처리"}
                </p>
              </div>
            );
          })}
        </div>

        <p className="border-t border-line bg-bg-soft px-4 py-3 text-[13px] leading-[1.7] text-fg-2">
          {bottleneck ? (
            <>
              병목 <b className="font-semibold text-down">{bottleneck.label}</b> — 지금 {bottleneck.waiting.toLocaleString("ko-KR")}건이
              쌓여 있는데 지난 24시간 동안 <b className="font-semibold">한 건도 빠지지 않았습니다</b>.
              {bottleneck.job ? <> 담당 작업 <span className="font-mono">{bottleneck.job}</span>이 도는지 확인하세요.</> : " 사람이 처리하는 단계입니다."}
            </>
          ) : (
            <>모든 단계에서 지난 24시간 동안 처리가 있었습니다. 쌓인 것은 있어도 멈춘 곳은 없습니다.</>
          )}
        </p>
      </div>
    </section>
  );
}
