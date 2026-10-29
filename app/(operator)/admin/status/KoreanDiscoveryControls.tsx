'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setKoreanDiscoveryControl } from './actions';

export function KoreanDiscoveryControls({ enabled, startAt, epoch }: { enabled: boolean; startAt: string | null; epoch: number }) {
  const [nextEnabled, setEnabled] = useState(enabled);
  const [date, setDate] = useState(startAt?.slice(0, 10) ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={event => {
    event.preventDefault();
    startTransition(async () => {
      try {
        const result = await setKoreanDiscoveryControl({ enabled: nextEnabled, epoch,
          startAt: date ? date === startAt?.slice(0, 10) ? startAt : `${date}T00:00:00.000Z` : null });
        setMessage(result.error ?? result.message ?? null);
        if (!result.error) router.refresh();
      } catch { setMessage('한국어 탐색 설정을 저장하지 못했습니다. 화면을 새로고침해 주세요.'); }
    });
  }}>
    <label className="text-[13px]"><input type="checkbox" checked={nextEnabled} disabled={pending} onChange={event => setEnabled(event.target.checked)} /> 한국어 탐색 활성화</label>
    <label className="text-[13px]">최초 과거 탐색 시작일 (UTC)<input type="date" value={date} disabled={pending} required={nextEnabled}
      onChange={event => setDate(event.target.value)} className="ml-2 rounded border border-line bg-transparent p-1" /></label>
    <button type="submit" disabled={pending} className="rounded border border-line px-3 py-1 text-[13px]">{pending ? '저장 중…' : '설정 저장'}</button>
    <p className="basis-full text-[13px] text-fg-2">시작한 탐색의 날짜·페이지는 유지합니다. 시작일 변경으로 기존 진행 위치를 초기화하지 않습니다.</p>
    {message && <p role="status" className="basis-full text-[13px]">{message}</p>}
  </form>;
}
