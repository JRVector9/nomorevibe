import type { AdminReviewVerdict } from "@/lib/crawl/admin-review";
import { CAUSE_GUIDE } from "./causes";

/**
 * 판정이 지나온 규칙.
 *
 * 저장된 사유 코드 하나로는 "왜 여기 있는지"를 알 수 없다. 규칙은 순수 함수이고 원본을
 * 보관하므로, 판정이 어디까지 통과하고 어디서 멈췄는지를 그대로 되짚어 보여준다.
 * 화면이 규칙을 따로 구현하지 않으므로 규칙을 고치면 이 목록도 함께 바뀐다.
 */
export function RuleTrace({ verdict }: { verdict: AdminReviewVerdict }) {
  const passed = verdict.trace.filter((step) => step.passed);
  const stopped = verdict.trace.at(-1);
  const guide = verdict.cause ? CAUSE_GUIDE[verdict.cause] : null;

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h4 className="text-[13.5px] font-bold">판정 근거</h4>
        <span className="text-[13px] text-fg-3">
          저장된 원본으로 규칙을 다시 태운 결과입니다 · 통과 {passed.length}개
        </span>
      </div>

      <ul className="mt-2 overflow-hidden rounded-[10px] border border-line">
        {verdict.trace.map((step, index) => (
          <li
            key={`${step.rule}:${index}`}
            className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line px-3 py-1.5 text-[13px] first:border-t-0 ${
              step.passed ? "" : "bg-bg-soft"
            }`}
          >
            <span className={`w-[14px] shrink-0 font-mono text-[13px] ${step.passed ? "text-up" : "text-down"}`}>
              {step.passed ? "✓" : "■"}
            </span>
            <span className={`min-w-[150px] ${step.passed ? "text-fg-2" : "font-bold text-fg"}`}>{step.rule}</span>
            <span className="min-w-0 flex-1 font-mono text-[13px] text-fg-3">{step.detail}</span>
          </li>
        ))}
      </ul>

      {stopped && !stopped.passed && (
        <p className="mt-2 text-[13px] leading-[1.7] text-fg-2">
          <b className="font-semibold text-fg">여기서 멈췄습니다.</b>{" "}
          {guide?.summary ?? "규칙이 이 지점에서 판단을 내렸습니다."}
        </p>
      )}

      {guide && (
        <div className="mt-3 rounded-[10px] border border-accent/30 bg-accent-soft px-4 py-3">
          <p className="text-[14px] font-bold leading-[1.6]">{guide.question}</p>
          <ul className="mt-2 flex flex-col gap-1 text-[13px] leading-[1.7] text-fg-2">
            {guide.hints.map((hint) => (
              <li key={hint.decision}>
                <b className="font-semibold text-fg">{hint.decision}</b> — {hint.when}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!verdict.matchesStored && (
        <p className="mt-3 rounded-[10px] border border-line bg-bg-soft px-3 py-2 text-[13px] leading-[1.7] text-fg-2">
          저장된 판정 이후 기준이 바뀌었습니다. 지금 기준으로 다시 판정하면{" "}
          <b className="font-semibold text-fg">{verdict.state} · {verdict.reason}</b> 입니다.
          크롤 설정에서 재판정하면 이 후보가 큐에서 빠질 수 있습니다.
        </p>
      )}
    </div>
  );
}
