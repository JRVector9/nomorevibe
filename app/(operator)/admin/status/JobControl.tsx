'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { controlJobAction } from './job-control-actions';

export function JobControl({ name, paused, notBefore, version, csrf }: { name: string; paused: boolean; notBefore: string | null; version: number;
  csrf: { token: string; expiresAt: number } }) {
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [pending, start] = useTransition();
  const [shown] = useState({ paused, notBefore, version });
  const changed = shown.paused !== paused || shown.notBefore !== notBefore || shown.version !== version;
  const router = useRouter();
  return <form data-dirty={reason.trim() ? true : undefined} className="mt-4 space-y-2 border-t border-line pt-3" onSubmit={event => {
    event.preventDefault();
    if (changed) return;
    start(async () => {
      try {
        const result = await controlJobAction({ name, pause: !shown.paused, expectedNotBefore: shown.notBefore, expectedControlVersion: shown.version,
          reason, csrfToken: csrf.token, csrfExpiresAt: csrf.expiresAt });
        setMessage(result.error ?? result.message ?? '');
        if (!result.error) setReason('');
        router.refresh();
      } catch { setMessage('변경을 확인하지 못했습니다. 새로고침해서 현재 상태를 확인해 주세요.'); }
    });
  }}>
    <p className="ops-note">{paused ? '이 작업만 재개합니다. 다른 작업의 중단 상태는 유지합니다.' : '이 작업의 다음 실행부터 멈춥니다. 실행 중인 호출은 끝까지 처리합니다.'}</p>
    <label className="block text-[13px]">{paused ? '재개 사유' : '멈춤 사유'}
      <input required maxLength={500} value={reason} disabled={pending} onChange={event => setReason(event.target.value)} className="mt-1 block w-full rounded border border-line bg-bg-card p-2" />
    </label>
    {changed && <p role="status">작업 상태가 바뀌었습니다. 상세를 닫고 다시 열어 현재 상태를 확인해 주세요.</p>}
    <button type="submit" disabled={pending || changed || !reason.trim()}>{pending ? '저장 중…' : paused ? '이 작업 재개' : '이 작업 멈춤'}</button>
    {message && <p role="status">{message}</p>}
  </form>;
}
