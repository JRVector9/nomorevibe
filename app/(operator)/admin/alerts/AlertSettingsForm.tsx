'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveConsoleAlertSettingsAction } from './actions';

type Settings = { enabled: boolean; quietStart: string | null; quietEnd: string | null };
const quietText = (start: string | null, end: string | null) => start && end ? `${start} ~ ${end}` : '없음';

/**
 * 휴대폰 알림 켜기·끄기와 조용한 시간(KST) — 고르기 → 저장 전 확인(바뀌는 것) → 저장. 저장은 작업 로그 한 줄(console-alert-settings)이다.
 * 조용한 시간에는 새 알림을 내보내지 않고 기다렸다가, 끝났을 때도 그 할 일이 있으면 보낸다. 이미 보낸 알림은 다시 보내지 않는다.
 */
export function AlertSettingsForm({ settings, basedOn, csrf, readOnly }: { settings: Settings; basedOn: string | null;
  csrf: { token: string; expiresAt: number } | null; readOnly: boolean }) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [start, setStart] = useState(settings.quietStart ?? '');
  const [end, setEnd] = useState(settings.quietEnd ?? '');
  const [step, setStep] = useState<'edit' | 'confirm'>('edit');
  const [message, setMessage] = useState('');
  const [pending, run] = useTransition();
  const router = useRouter();
  const locked = readOnly || !csrf;
  const changes = [
    enabled !== settings.enabled ? { label: '알림', before: settings.enabled ? '켜짐' : '꺼짐', after: enabled ? '켜짐' : '꺼짐' } : null,
    (start || null) !== settings.quietStart || (end || null) !== settings.quietEnd
      ? { label: '조용한 시간', before: quietText(settings.quietStart, settings.quietEnd), after: quietText(start || null, end || null) } : null,
  ].filter((row): row is { label: string; before: string; after: string } => row !== null);

  return <form className="al-form" onSubmit={event => {
    event.preventDefault();
    if (step === 'edit') { setMessage(''); setStep('confirm'); return; }
    if (!csrf) return;
    run(async () => {
      try {
        const result = await saveConsoleAlertSettingsAction({ enabled, quietStart: start, quietEnd: end, basedOn, csrfToken: csrf.token, csrfExpiresAt: csrf.expiresAt });
        setMessage(result.error ?? result.message ?? '');
        setStep('edit');
        if (!result.error) router.refresh();
      } catch { setMessage('저장을 확인하지 못했습니다. 새로고침해서 지금 상태를 확인해 주세요.'); setStep('edit'); }
    });
  }}>
    {step === 'edit' ? <>
      <label className="al-check"><input type="checkbox" checked={enabled} disabled={locked || pending} onChange={event => setEnabled(event.target.checked)} />
        멈춤 · 평소와 다름이 새로 생기면 휴대폰으로 알림</label>
      <fieldset className="al-quiet" disabled={locked || pending}><legend>조용한 시간(KST) — 비우면 없음</legend>
        <label>시작<input type="time" value={start} onChange={event => setStart(event.target.value)} /></label>
        <label>끝<input type="time" value={end} onChange={event => setEnd(event.target.value)} /></label>
      </fieldset>
      <div className="al-acts"><button type="submit" className="button small primary" disabled={locked || pending || changes.length === 0}>저장 전 확인</button>
        {locked && <span className="al-muted">{readOnly ? '읽기 전용 미리보기 — 여기서는 저장할 수 없습니다.' : '저장 확인 토큰이 없어 저장할 수 없습니다.'}</span>}</div>
    </> : <div className="al-confirm" role="group" aria-label="저장 전 확인">
      <h3>알림 설정을 바꿉니다</h3>
      <ul className="al-diff">{changes.map(row => <li key={row.label}><span>{row.label}</span><span><s>{row.before}</s> {row.after}</span></li>)}</ul>
      {enabled && !settings.enabled && <p className="al-muted">켜면 다음 알림 작업(5분 안)에 지금 있는 멈춤 · 평소와 다름을 한 번씩 보냅니다. 받는 곳은 장애 알림과 같은 Telegram 대화방입니다.</p>}
      <div className="al-acts"><button type="submit" className="button small primary" disabled={pending}>{pending ? '저장 중…' : '저장'}</button>
        <button type="button" className="button small" disabled={pending} onClick={() => setStep('edit')}>취소</button></div>
    </div>}
    {message && <p role="status" className="al-muted">{message}</p>}
  </form>;
}
