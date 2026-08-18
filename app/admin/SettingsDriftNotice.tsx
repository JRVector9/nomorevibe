"use client";

import { useActionState } from "react";
import { resetCrawlSettings, type SaveState } from "./actions";
import type { SettingsDrift } from "@/lib/crawl/settings";
import { Panel } from "@/components/Panel";

/**
 * 저장된 기준이 코드 기본값과 어긋났을 때만 뜬다.
 *
 * 설정은 데이터라 한 번 저장하면 그 값이 이긴다. 판정 규칙을 고쳐 기본값을 바꿔도 이미 돌고
 * 있는 환경은 옛 값으로 돈다 — 조용히 어긋나는 것이 문제라서 어긋난 것을 보여준다.
 */
export function SettingsDriftNotice({ drift }: { drift: SettingsDrift }) {
  const [state, action, pending] = useActionState<SaveState, FormData>(
    () => resetCrawlSettings(),
    null,
  );

  if (drift.length === 0) return null;

  return (
    <div className="mt-6">
      <Panel
        tone="warn"
        title="저장된 기준이 기본값과 다릅니다"
        actions={<span className="text-[12.5px] text-fg-2">{drift.length}항목</span>}
        note="기준을 한 번 저장하면 그 값이 코드 기본값을 덮습니다. 판정 규칙을 고쳐 기본값이 바뀌어도 여기는 옛 값으로 돕니다. 일부러 조정한 것이면 그대로 두세요."
      >
      <dl className="flex flex-col gap-2 text-[12px]">
        {drift.map((item) => (
          <div key={item.label} className="flex flex-wrap items-baseline gap-x-2">
            <dt className="w-[110px] shrink-0 font-semibold text-fg-2">{item.label}</dt>
            <dd className="font-mono text-fg">{item.stored}</dd>
            <dd className="font-mono text-fg-3">← 기본값 {item.standard}</dd>
          </div>
        ))}
      </dl>

      <form action={action} className="mt-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-line bg-bg-soft px-3 py-1.5 text-[12.5px] font-semibold text-fg-2 hover:text-fg disabled:opacity-50"
        >
          {pending ? "되돌리는 중…" : "기본값으로 되돌리기"}
        </button>
        <span className="ml-2 text-[11.5px] text-fg-3">수집 스위치는 건드리지 않습니다</span>
      </form>
      {state?.issues && <p className="mt-2 text-[12px] text-down">{state.issues.join(", ")}</p>}
      </Panel>
    </div>
  );
}
