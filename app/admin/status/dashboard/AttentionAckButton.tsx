'use client';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { resultToast, useAdminToast } from '../../components/Toast';
import { acknowledgeAttention } from '../actions';

/**
 * 쌓인 일의 "확인함 · 7일 숨김"과 숨긴 것의 "다시 보이기" — 고른 것은 관리자 작업 로그에 남는다(ADM-08).
 * 숨긴 뒤 알림의 되돌리기는 같은 항목을 다시 보이게 한다.
 */
export function AttentionAckButton({ itemKey, title, count, hide }: { itemKey: string; title: string; count: number | string; hide: boolean }) {
  const router = useRouter();
  const toast = useAdminToast();
  const [pending, start] = useTransition();
  const set = async (next: boolean) => {
    const result = await acknowledgeAttention({ key: itemKey, hide: next, count });
    router.refresh();
    return result;
  };
  return (
    <button type="button" className="dash-todo-ack" disabled={pending} onClick={() => start(async () => {
      const result = await set(hide);
      toast.show(resultToast(result, hide
        ? { message: `숨김 · ${title} — 7일 뒤 다시 보입니다`, link: { label: '기록 보기', href: '/admin/activity' }, undo: { run: () => set(false) } }
        : `다시 보임 · ${title}`));
    })}>
      {pending ? '처리 중…' : hide ? '확인함 · 7일 숨김' : '다시 보이기'}
    </button>
  );
}
