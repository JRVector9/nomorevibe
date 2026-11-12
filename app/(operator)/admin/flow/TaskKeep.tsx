'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CONSOLE_KEEP_REASON_MAX } from '@/lib/operations/console-tasks';
import { keepConsoleTaskAction } from './task-keep-actions';

/**
 * 할 일 「사유 남기고 유지」·「그대로 두기」의 폼 — 사유를 적어야 저장한다(작업 멈춤·재개 폼 JobControl 과 같은 모양·같은 CSRF).
 * 저장하면 작업 로그에 한 줄이 남고, 정한 기간 동안 이 할 일이 목록에서 내려가 「그대로 둔 것」에 적힌다.
 */
export function TaskKeep({ taskId, keepRef, title, label, days, csrf }: { taskId: string; keepRef: string | null; title: string; label: string; days: number;
  csrf: { token: string; expiresAt: number } }) {
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();
  return <form data-dirty={reason.trim() ? true : undefined} className="ch-keep-form" onSubmit={event => {
    event.preventDefault();
    start(async () => {
      try {
        const result = await keepConsoleTaskAction({ taskId, ref: keepRef, reason, title, csrfToken: csrf.token, csrfExpiresAt: csrf.expiresAt });
        setMessage(result.error ?? result.message ?? '');
        if (!result.error) { setReason(''); router.refresh(); }
      } catch { setMessage('저장을 확인하지 못했습니다. 새로고침해서 지금 상태를 확인해 주세요.'); }
    });
  }}>
    <p className="ch-keep-note">「{title}」을(를) 확인했고 지금은 그대로 둡니다. {days}일 동안 목록에서 내리고, 그때도 같으면 다시 올라옵니다. 작업·모델은 바꾸지 않습니다.</p>
    <label className="ch-keep-label">사유
      <input required maxLength={CONSOLE_KEEP_REASON_MAX} value={reason} disabled={pending} onChange={event => setReason(event.target.value)} />
    </label>
    <button type="submit" className="button small primary" disabled={pending || !reason.trim()}>{pending ? '저장 중…' : label}</button>
    {message && <p role="status" className="ch-keep-note">{message}</p>}
  </form>;
}
