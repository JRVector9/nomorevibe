"use client";

import { useActionState, useState } from "react";
import type { EvidenceSettings } from "@/lib/domain/evidence/settings";
import { saveEvidenceSettings } from "./actions";

export function numberOrPrevious(value: string, previous: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : previous;
}

const FIELDS = [
  { key: "githubFactsHours", label: "GitHub 사실 갱신", unit: "시간", min: 6, max: 168, step: 1 },
  { key: "releaseFeedHours", label: "릴리스·피드 갱신", unit: "시간", min: 1, max: 48, step: 1 },
  { key: "linkCheckHours", label: "링크·미디어 확인", unit: "시간", min: 6, max: 168, step: 1 },
  { key: "staleAfterIntervals", label: "오래됨 판정", unit: "회 실패", min: 2, max: 10, step: 1 },
  { key: "maxRetries", label: "최대 재시도", unit: "회", min: 1, max: 8, step: 1 },
  { key: "batchSize", label: "한 번에 처리", unit: "제품", min: 1, max: 100, step: 1 },
  { key: "starDigestAbsolute", label: "별 증가 절대값", unit: "개", min: 5, max: 10_000, step: 1 },
  { key: "starDigestPercent", label: "별 증가율", unit: "%", min: 1, max: 100, step: 0.1 },
] as const satisfies ReadonlyArray<{
  key: keyof EvidenceSettings;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
}>;

export function EvidenceSettingsForm({ initialSettings }: { initialSettings: EvidenceSettings }) {
  const [settings, setSettings] = useState(initialSettings);
  const [state, action, pending] = useActionState(saveEvidenceSettings, null);
  return (
    <form action={action} className="rounded-[12px] border border-line bg-bg-card p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((field) => (
          <label key={field.key} className="flex flex-col gap-1.5 text-[13px] font-semibold text-fg-2">
            <span>{field.label}</span>
            <span className="flex items-center gap-2">
              <input
                name={field.key}
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                value={settings[field.key]}
                onChange={(event) => setSettings((current) => ({
                  ...current,
                  [field.key]: numberOrPrevious(event.target.value, current[field.key]),
                }))}
                className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
              />
              <span className="w-[54px] text-[13px] font-medium text-fg-3">{field.unit}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-accent px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50"
        >
          {pending ? "저장 중" : "설정 저장"}
        </button>
        <div aria-live="polite" className="text-[13px] text-fg-2">
          {state?.ok && "저장했습니다."}
          {state?.issues?.map((issue) => <p key={issue} className="text-down">{issue}</p>)}
        </div>
      </div>
    </form>
  );
}
