"use client";

import { useActionState, useState } from "react";
import type { CategoryDefinitions } from "@/lib/crawl/settings-schema";
import { CATEGORIES, type Category } from "@/lib/domain/products/categories";
import { saveCategoryDefinitions } from "./actions";

const field = "mt-2 block w-full rounded-lg border border-line bg-bg-soft px-3 py-2 text-[13px] text-fg outline-none focus:border-accent";

export function CategoryDefinitionsForm({
  definitions,
  counts,
}: {
  definitions: CategoryDefinitions;
  counts: Record<string, number>;
}) {
  const [selected, setSelected] = useState<Category>("Dev");
  const [state, action, pending] = useActionState(saveCategoryDefinitions, null);
  const current = definitions[selected];

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <ul className="max-h-[620px] overflow-y-auto rounded-[12px] border border-line bg-bg-card">
        {CATEGORIES.map((name) => {
          const edited = definitions[name].include.length > 0 || definitions[name].exclude.length > 0;
          return (
            <li key={name}>
              <button
                type="button"
                aria-pressed={selected === name}
                onClick={() => setSelected(name)}
                className={`flex w-full items-center gap-2 border-t border-line px-3 py-2.5 text-left text-[13px] first:border-t-0 ${
                  selected === name ? "bg-accent-soft font-bold text-accent" : "text-fg-2 hover:bg-bg-hover"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {edited && <span className="text-[13px] text-accent">기준 추가됨</span>}
                <span className="font-mono text-[13px] text-fg-3">{counts[name] ?? 0}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* key로 카테고리를 갈아끼운다 — 다른 항목을 고르면 입력값이 그 항목 값으로 다시 채워져야 한다 */}
      <form key={selected} action={action} className="rounded-[12px] border border-line bg-bg-card p-5">
        <input type="hidden" name="category" value={selected} />
        <h2 className="text-[18px] font-extrabold tracking-tight">
          {selected} <span className="text-[13px] font-medium text-fg-3">· 공개 제품 {counts[selected] ?? 0}개</span>
        </h2>

        <label className="mt-5 block text-[13px] font-semibold text-fg-2">
          이 카테고리의 정의
          <span className="mt-1 block text-[13px] font-normal text-fg-3">
            한 문장으로 씁니다. 이 문장이 분류 모델에 그대로 전달됩니다.
          </span>
          <textarea name="summary" required maxLength={300} rows={2} defaultValue={current.summary} className={field} />
        </label>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block text-[13px] font-semibold text-fg-2">
            여기에 넣을 것
            <span className="mt-1 block text-[13px] font-normal text-fg-3">한 줄에 하나. 애매할 때 기준이 됩니다.</span>
            <textarea name="include" rows={5} defaultValue={current.include.join("\n")} className={`${field} font-normal`}
              placeholder={"웹 게임\n게임 수치 계산기"} />
          </label>
          <label className="block text-[13px] font-semibold text-fg-2">
            여기에 넣지 말 것
            <span className="mt-1 block text-[13px] font-normal text-fg-3">잘못 분류된 것을 볼 때마다 추가하세요.</span>
            <textarea name="exclude" rows={5} defaultValue={current.exclude.join("\n")} className={`${field} font-normal`}
              placeholder={"게임 엔진 → Dev"} />
          </label>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <button type="submit" disabled={pending}
            className="rounded-lg bg-accent px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50">
            {pending ? "저장 중" : `${selected} 기준 저장`}
          </button>
          <div aria-live="polite" className="text-[13px] text-fg-2">
            {state?.ok && "저장했습니다. 다음 분류부터 적용됩니다."}
            {state?.issues?.map((issue) => <p key={issue} className="text-down">{issue}</p>)}
          </div>
        </div>
        <p className="mt-3 text-[13px] leading-6 text-fg-3">
          이미 발행된 제품의 카테고리는 그대로 둡니다. 기준을 바꿔도 다음 분류부터 적용됩니다.
          최대 12개씩, 각 120자까지 적을 수 있습니다.
        </p>
      </form>
    </div>
  );
}
