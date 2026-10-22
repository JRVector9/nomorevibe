"use client";

import { useActionState } from "react";
import { decideTalkHome, type TalkActionState } from "./actions";

export type TalkHomeRow = {
  rank: number;
  repositoryKey: string;
  slug: string;
  name: string;
  best: string;
  decision: "approved" | "talk_only" | null;
  onHome: "lead" | "rest" | "waiting" | null;
};

const DECISION_LABEL = { approved: "1위 허용", talk_only: "/talk 에만", none: "정하지 않음" } as const;
const ON_HOME_LABEL = { lead: "지금 홈 1위", rest: "홈 목록", waiting: "확인 대기 — 1위를 건너뜀" } as const;

/**
 * 홈 첫 화면 1위 자리(C안) — 사람이 한 번 본 제품만 오른다. 허용하지 않은 동안은 다음 순위가 1위 자리에 선다.
 * 2~5위 목록은 허용을 기다리지 않는다. /talk 에만 두면 홈에서는 빠진다.
 */
export function TalkHomeBoard({ rows }: { rows: TalkHomeRow[] }) {
  const [state, action, pending] = useActionState<TalkActionState, FormData>(decideTalkHome, null);
  return (
    <div className="flex flex-col gap-2">
      <div aria-live="polite">
        {state?.error && <p className="text-[13px] text-down">{state.error}</p>}
        {state?.ok && <p className="text-[13px] font-semibold text-up">{state.ok}</p>}
      </div>
      <ol className="flex flex-col divide-y divide-line rounded-[12px] border border-line bg-bg-card">
        {rows.map(row => (
          <li key={row.repositoryKey} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[13px]">
            <span className="w-6 text-right font-mono text-fg-3">{row.rank}</span>
            <span className="min-w-0 flex-1">
              <a href={`/p/${row.slug}`} target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline">{row.name}</a>
              <span className="ml-2 font-mono text-[13px] text-fg-3">{row.repositoryKey}</span>
              <span className="block text-fg-2">{row.best}{row.onHome && <> · <b className="font-semibold text-fg">{ON_HOME_LABEL[row.onHome]}</b></>}</span>
            </span>
            <span className="rounded-full border border-line px-2 py-0.5 text-[13px] text-fg-2">{DECISION_LABEL[row.decision ?? "none"]}</span>
            <form action={action} className="flex gap-1">
              <input type="hidden" name="repository" value={row.repositoryKey} />
              <button type="submit" name="decision" value="approved" disabled={pending || row.decision === "approved"}
                className="rounded-md border border-up/40 bg-up/10 px-2 py-1 text-[13px] font-semibold text-up disabled:opacity-40">1위 허용</button>
              <button type="submit" name="decision" value="talk_only" disabled={pending || row.decision === "talk_only"}
                className="rounded-md border border-line px-2 py-1 text-[13px] disabled:opacity-40">/talk 에만</button>
              {/* 결정만 거둔다(정하지 않음) — 제품·글은 지우지 않는다. 정하지 않음이면 홈 1위 자리는 건너뛴다 */}
              <button type="submit" name="decision" value="clear" disabled={pending || row.decision === null}
                title="1위 허용·/talk 에만 결정을 거두고 '정하지 않음'으로 되돌립니다. 제품이나 글은 지우지 않습니다."
                className="rounded-md border border-line px-2 py-1 text-[13px] text-fg-3 disabled:opacity-40">정하지 않음으로</button>
            </form>
          </li>
        ))}
        {rows.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-fg-3">지금 화제 순위에 오른 공개 제품이 없습니다.</li>}
      </ol>
    </div>
  );
}
