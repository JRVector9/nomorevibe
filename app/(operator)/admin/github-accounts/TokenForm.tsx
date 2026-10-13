"use client";

import { useActionState, useState } from "react";
import { saveCollectorToken } from "./actions";

export function TokenForm({ accounts, ready }: { accounts: { userId: number; login: string }[]; ready: boolean }) {
  const [state, action, pending] = useActionState(saveCollectorToken, null);
  const [replace, setReplace] = useState("");
  return <form action={action} className="rounded-xl border border-line bg-bg-card p-5">
    <h2 className="text-[17px] font-bold">수집 토큰 등록·교체</h2>
    <p className="mt-2 text-[13px] leading-6 text-fg-2">다른 GitHub 계정의 PAT를 등록하면 수집 워커가 그 계정도 사용합니다. 이미 등록된 계정의 PAT는 자동으로 교체됩니다.</p>
    <label className="mt-4 block text-[13px] font-semibold">작업
      <select name="replaceUserId" value={replace} onChange={event => setReplace(event.target.value)}
        className="mt-2 block w-full rounded-lg border border-line bg-bg-soft px-3 py-2 text-[13px]">
        <option value="">새 계정 등록 또는 동일 계정 자동 교체</option>
        {accounts.map(account => <option key={account.userId} value={account.userId}>{account.login} 토큰 교체</option>)}
      </select>
    </label>
    <label className="mt-4 block text-[13px] font-semibold">GitHub Personal Access Token
      <input name="token" type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} required minLength={20} maxLength={512}
        placeholder="github_pat_…" className="mt-2 block w-full rounded-lg border border-line bg-bg-soft px-3 py-2 font-mono text-[13px]" />
    </label>
    <p className="mt-2 text-[13px] leading-5 text-fg-3">공개 저장소 읽기용 fine-grained PAT면 됩니다. 토큰 원문은 저장 후 다시 표시되지 않습니다.</p>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button type="submit" disabled={!ready || pending} className="rounded-lg bg-accent-solid px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50">
        {pending ? "GitHub 확인 중…" : "토큰 확인 후 저장"}
      </button>
      <span aria-live="polite" className="text-[13px] text-fg-2">{state?.ok ?? state?.error ?? (!ready ? "암호화 키 설정 후 사용할 수 있습니다." : "")}</span>
    </div>
  </form>;
}
