"use client";

import { useActionState } from "react";
import { resetCrawlSettings, type SaveState } from "./actions";
import type { SettingsDrift, SettingsDriftItem } from "@/lib/crawl/settings";
import { Panel } from "@/components/Panel";

/**
 * 저장된 기준이 코드 기본값과 어긋났을 때만 뜬다.
 *
 * 설정은 데이터라 한 번 저장하면 그 값이 이긴다. 판정 규칙을 고쳐 기본값을 바꿔도 이미 돌고
 * 있는 환경은 옛 값으로 돈다 — 조용히 어긋나는 것이 문제라서 어긋난 것을 보여준다.
 *
 * 값 둘을 나란히 늘어놓던 때는 읽을 수는 있어도 고를 수가 없었다. 차단 도메인 스물넷과 열다섯을
 * 나란히 놓으면 무엇이 빠졌는지 사람이 눈으로 빼야 했다(2026-09-18, 사용자가 판단 못 하겠다고 함).
 * 지금은 빠진 것만 세어 보여 주고, 갈래를 나눠 "실수로 안 들어온 것"과 "일부러 바꾼 것"을 가른다.
 */
export function SettingsDriftNotice({ drift }: { drift: SettingsDrift }) {
  const [state, action, pending] = useActionState<SaveState, FormData>(
    () => resetCrawlSettings(),
    null,
  );

  if (drift.length === 0) return null;

  const absent = drift.filter((item) => item.kind === "absent");
  const changed = drift.filter((item) => item.kind === "changed");

  return (
    <div className="mt-6">
      <Panel
        tone="warn"
        title="저장된 기준이 기본값과 다릅니다"
        actions={<span className="text-[13px] text-fg-2">{drift.length}항목</span>}
        note="기준을 한 번 저장하면 그 값이 코드 기본값을 덮습니다. 그래서 규칙을 고쳐도 이 환경에는 닿지 않습니다."
      >
        <div className="flex flex-col gap-5">
          {absent.length > 0 && (
            <Group
              heading="새 기본값이 닿지 못했습니다"
              hint="코드에 추가된 항목이 저장된 값에 막혀 적용되지 않고 있습니다. 대개 의도한 것이 아닙니다."
              items={absent}
              render={(item) => (
                <>
                  <strong className="font-semibold text-down">{item.absent.length}개 빠짐</strong>
                  <span className="font-mono text-fg-2"> {item.absent.join(", ")}</span>
                </>
              )}
            />
          )}

          {changed.length > 0 && (
            <Group
              heading="값이 다릅니다"
              hint="일부러 조정한 것이면 그대로 두세요."
              items={changed}
              render={(item) => (
                <>
                  <span className="font-mono text-fg">{shorten(item.stored)}</span>
                  <span className="text-fg-3"> ← 기본값 </span>
                  <span className="font-mono text-fg-3">{shorten(item.standard)}</span>
                  {(item.absent.length > 0 || item.extra.length > 0) && (
                    <span className="text-fg-3">
                      {item.extra.length > 0 && ` · 여기에만 ${item.extra.length}개`}
                      {item.absent.length > 0 && ` · ${item.absent.length}개 빠짐`}
                    </span>
                  )}
                </>
              )}
            />
          )}
        </div>

        <form action={action} className="mt-5">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg border border-line bg-bg-soft px-3 py-1.5 text-[13px] font-semibold text-fg-2 hover:text-fg disabled:opacity-50"
          >
            {pending ? "되돌리는 중…" : `${drift.length}항목 전부 기본값으로 되돌리기`}
          </button>
          <span className="ml-2 text-[13px] text-fg-3">
            {changed.length > 0
              ? `일부러 바꾼 값도 함께 되돌아갑니다 (${changed.map((item) => item.label).join(", ")})`
              : "수집 스위치는 건드리지 않습니다"}
          </span>
        </form>
        {state?.issues && <p className="mt-2 text-[13px] text-down">{state.issues.join(", ")}</p>}
      </Panel>
    </div>
  );
}

/** 긴 목록은 통째로 보여도 읽히지 않는다 — 앞부분과 개수만 남긴다 */
function shorten(value: string): string {
  if (value.length <= 90) return value;
  const items = value.split(", ");
  if (items.length < 3) return `${value.slice(0, 88)}…`;
  const head = items.slice(0, 3).join(", ");
  return `${head} 외 ${items.length - 3}개`;
}

function Group({ heading, hint, items, render }: {
  heading: string;
  hint: string;
  items: SettingsDriftItem[];
  render: (item: SettingsDriftItem) => React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-[13px] font-extrabold text-fg">{heading}</h3>
      <p className="mt-0.5 text-[13px] text-fg-3">{hint}</p>
      <dl className="mt-2 flex flex-col gap-1.5 text-[13px]">
        {items.map((item) => (
          <div key={item.label} className="flex flex-wrap items-baseline gap-x-2">
            <dt className="w-[120px] shrink-0 font-semibold text-fg-2">{item.label}</dt>
            <dd className="min-w-0 break-words">{render(item)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
