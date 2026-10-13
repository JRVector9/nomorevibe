"use client";

import { resetCrawlSettings } from "./actions";
import { ConfirmAction } from "./components/ConfirmAction";
import { useAdminToast } from "./components/Toast";
import type { ResetLine } from "./settings/reset-diff";
import type { SettingsDrift, SettingsDriftItem } from "@/lib/crawl/settings";

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
export function SettingsDriftNotice({ drift, reset = [] }: { drift: SettingsDrift; reset?: ResetLine[] }) {
  const toast = useAdminToast();

  if (drift.length === 0) return null;

  const absent = drift.filter((item) => item.kind === "absent");
  const changed = drift.filter((item) => item.kind === "changed");

  /*
   * 2026-10-08 리디자인: 맨 위의 큰 경고 상자에서 맨 아래 접힌 상자로 옮겼다. 오류가 아니라 비교라서다.
   * 목록에서 빠진 기본값은 거르는 목록 카드 안에서도 보이고 "모두 더하기"로 채운다.
   */
  return (
    <details id="defaults" className="group scroll-mt-6 rounded-[12px] border border-line bg-bg-card px-[22px] py-4">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-2 [&::-webkit-details-marker]:hidden">
        <h2 className="text-[17px] font-semibold tracking-tight">기본값과 비교</h2>
        <span className="text-[13px] font-semibold text-warn">다른 항목 {drift.length}개</span>
        <span className="ml-auto text-[13px] font-semibold text-accent-ink group-open:hidden">펼치기</span>
      </summary>
      <p className="mt-2 max-w-[72ch] text-[13px] leading-[1.6] text-fg-3">
        기준을 한 번 저장하면 그 값이 코드 기본값을 덮습니다. 그래서 규칙을 고쳐도 이 환경에는 닿지 않습니다.
      </p>
      <div className="mt-4">
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

        {/* 일부러 바꾼 값까지 덮으므로 바뀔 값을 한 번 훑고 누르게 한다(2026-10-08 UX 감사 ADM-06) */}
        <div className="mt-5">
          <ConfirmAction
            title="크롤 설정을 기본값으로 되돌립니다"
            confirmLabel={`${reset.length}개 값 되돌리기`}
            summary={<ResetSummary lines={reset} />}
            onConfirm={async () => {
              const result = await resetCrawlSettings();
              if (result?.ok) toast.show({ message: "기본값으로 되돌렸습니다 — 다음 틱부터 적용됩니다" });
              return result;
            }}
            trigger={(open) => (
              <button type="button" onClick={open}
                className="rounded-lg border border-line bg-bg-soft px-3 py-1.5 text-[13px] font-semibold text-fg-2 hover:text-fg">
                {`${drift.length}항목 전부 기본값으로 되돌리기`}
              </button>
            )}
          />
          <span className="ml-2 text-[13px] text-fg-3">
            {changed.length > 0
              ? `일부러 바꾼 값도 함께 되돌아갑니다 (${changed.map((item) => item.label).join(", ")})`
              : "수집 스위치는 건드리지 않습니다"}
          </span>
        </div>
      </div>
    </details>
  );
}

/** 확인 창 — 되돌리면 바뀔 값(지금 → 기본값). 비교표에 없는 값(심사·카테고리 기준 등)도 여기에는 다 나온다 */
function ResetSummary({ lines }: { lines: ResetLine[] }) {
  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <p className="text-fg-2">바뀌는 값 {lines.length}개 · 지금 → 기본값. 수집 켜짐·꺼짐과 발행 보호(리뷰 모드)는 그대로 둡니다.</p>
      <ul className="flex max-h-[40dvh] flex-col gap-1 overflow-y-auto" aria-label="바뀔 값">
        {lines.map((line) => (
          <li key={line.label} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold text-fg">{line.label}</span>
            <span className="font-mono text-fg-2">{line.before}</span>
            <span className="text-fg-3">→</span>
            <span className="font-mono font-semibold text-fg">{line.after}</span>
            {line.note && <span className="w-full break-words text-fg-3">{line.note}</span>}
          </li>
        ))}
      </ul>
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
