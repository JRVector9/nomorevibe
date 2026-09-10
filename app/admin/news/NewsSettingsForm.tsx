"use client";

import { useActionState } from "react";
import { refreshNewsNow, saveNewsSettings, type NewsActionState } from "./actions";

export type NewsSourceRow = {
  key: string;
  name: string;
  vendor: string;
  kindLabel: string;
  sectionLabel: string;
  url: string;
  enabled: boolean;
  status: string;
  failing: boolean;
};

function Feedback({ state }: { state: NewsActionState }) {
  return (
    <div aria-live="polite">
      {state?.error && <p className="text-[13px] text-down">{state.error}</p>}
      {state?.ok && <p className="text-[13px] font-semibold text-up">{state.ok}</p>}
    </div>
  );
}

/** 자동 승인과 출처 켜기·끄기. 한 번에 저장한다 */
export function NewsSettingsForm({ autoApprove, sources }: { autoApprove: boolean; sources: NewsSourceRow[] }) {
  const [saved, save, saving] = useActionState<NewsActionState, FormData>(saveNewsSettings, null);
  const [refreshed, refresh, refreshing] = useActionState<NewsActionState>(refreshNewsNow, null);

  return (
    <div className="flex flex-col gap-4">
      <form action={save} className="flex flex-col gap-4">
        <label className="flex items-start gap-3 rounded-[12px] border border-line bg-bg-card p-4">
          <input type="checkbox" name="autoApprove" defaultChecked={autoApprove} className="mt-1" />
          <span>
            <b className="text-[14px] font-semibold">새 글 자동 승인</b>
            <span className="mt-1 block text-[13px] leading-[1.6] text-fg-2">
              켜 두면 수집한 글이 곧바로 홈에 오릅니다. 끄면 새 글은 승인 대기로 들어가고, 아래 목록에서 게시해야 오릅니다.
            </span>
          </span>
        </label>

        <div className="overflow-x-auto rounded-[12px] border border-line bg-bg-card">
          <table className="w-full min-w-[720px] text-[13px]">
            <thead className="text-left text-fg-3">
              <tr className="border-b border-line">
                <th className="px-3 py-2 font-semibold">수집</th>
                <th className="px-3 py-2 font-semibold">출처</th>
                <th className="px-3 py-2 font-semibold">종류</th>
                <th className="px-3 py-2 font-semibold">마지막 수집</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.key} className="border-b border-line last:border-0 align-top">
                  <td className="px-3 py-2">
                    <input type="checkbox" name="source" value={source.key} defaultChecked={source.enabled} aria-label={`${source.name} 수집`} />
                  </td>
                  <td className="px-3 py-2">
                    <b className="font-semibold">{source.name}</b>
                    <a href={source.url} target="_blank" rel="noopener noreferrer" className="mt-0.5 block break-all font-mono text-[13px] text-fg-3 hover:underline">
                      {source.url}
                    </a>
                  </td>
                  <td className="px-3 py-2 text-fg-2">{source.sectionLabel} · {source.kindLabel}</td>
                  <td className={`px-3 py-2 ${source.failing ? "text-down" : "text-fg-2"}`}>{source.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={saving} className="rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-50">
            {saving ? "저장하는 중…" : "설정 저장"}
          </button>
          <Feedback state={saved} />
        </div>
      </form>

      <form action={refresh} className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={refreshing} className="rounded-lg border border-line bg-bg-card px-3 py-2 text-[13px] font-semibold disabled:opacity-50">
          {refreshing ? "요청하는 중…" : "지금 수집"}
        </button>
        <span className="text-[13px] text-fg-3">평소에는 한 시간마다 돕니다.</span>
        <Feedback state={refreshed} />
      </form>
    </div>
  );
}
