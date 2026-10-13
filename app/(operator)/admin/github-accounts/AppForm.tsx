"use client";

import { useActionState } from "react";
import { saveCollectorApp } from "./actions";

/** GitHub App 등록 — 같은 계정이어도 설치마다 한도가 따로라, 개인 토큰을 더하는 대신 쓴다(github-apps.ts) */
export function AppForm({ ready }: { ready: boolean }) {
  const [state, action, pending] = useActionState(saveCollectorApp, null);
  const field = "mt-2 block w-full rounded-lg border border-line bg-bg-soft px-3 py-2 font-mono text-[13px]";
  return <form action={action} className="rounded-xl border border-line bg-bg-card p-5">
    <h2 className="text-[17px] font-bold">GitHub App 등록</h2>
    <p className="mt-2 text-[13px] leading-6 text-fg-2">
      같은 GitHub 계정의 토큰을 더해도 한도는 늘지 않습니다. 그 계정에서 GitHub App 을 만들어 설치하면 설치마다 따로 한도(시간당 5,000건 이상)가 생깁니다.
      권한은 기본값(Metadata 읽기)만 있으면 됩니다.
    </p>
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="block text-[13px] font-semibold">App ID
        <input name="appId" inputMode="numeric" pattern="[0-9]+" required className={field} placeholder="1234567" />
      </label>
      <label className="block text-[13px] font-semibold">Installation ID
        <input name="installationId" inputMode="numeric" pattern="[0-9]+" required className={field} placeholder="98765432" />
      </label>
    </div>
    <label className="mt-4 block text-[13px] font-semibold">개인 키(.pem 파일 내용 전체)
      <textarea name="privateKey" required rows={5} autoComplete="off" autoCapitalize="off" spellCheck={false}
        placeholder="-----BEGIN RSA PRIVATE KEY-----" className={field} />
    </label>
    <p className="mt-2 text-[13px] leading-5 text-fg-3">App ID 는 App 설정 첫 화면에, Installation ID 는 설치 설정 주소(github.com/settings/installations/숫자) 끝에 있습니다. 개인 키는 확인 뒤 암호화해 두고 다시 표시하지 않습니다.</p>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button type="submit" disabled={!ready || pending} className="rounded-lg bg-accent-solid px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50">
        {pending ? "GitHub 확인 중…" : "App 확인 후 저장"}
      </button>
      <span aria-live="polite" className="text-[13px] text-fg-2">{state?.ok ?? state?.error ?? (!ready ? "암호화 키 설정 후 사용할 수 있습니다." : "")}</span>
    </div>
  </form>;
}
