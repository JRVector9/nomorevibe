'use client';

import { useRef } from 'react';
import type { TranslationFailure } from '@/lib/crawl/translations';

/**
 * 실패 사유는 눌러야 보인다.
 *
 * 한 줄에 다 늘어놓으니 사유 넷이 진행 막대보다 길어져, 늘 잘 돌고 있을 때도 실패가 화면을
 * 차지했다. 평소에는 건수만 두고 눌렀을 때 자세히 보인다.
 */
export function TranslationFailures({ failed, failures }: { failed: number; failures: TranslationFailure[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const count = failed.toLocaleString('ko-KR');

  if (failures.length === 0) return <>실패 {count}</>;

  return (
    <>
      실패{' '}
      <button type="button" onClick={() => dialog.current?.showModal()}
        className="rounded-[6px] border border-line bg-bg-card px-1.5 font-mono tabular-nums text-fg underline decoration-dotted underline-offset-2"
        aria-haspopup="dialog">{count}</button>
      <dialog ref={dialog} onClick={(event) => { if (event.target === dialog.current) dialog.current?.close(); }}
        className="w-[min(560px,92vw)] rounded-[12px] border border-line bg-bg-card p-0 text-fg backdrop:bg-black/30">
        <div className="flex flex-col gap-3 p-5 text-[13px]">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-extrabold">사유 번역 실패 {count}건</h2>
            <button type="button" onClick={() => dialog.current?.close()} className="text-fg-3 hover:text-fg">닫기</button>
          </div>
          <table className="w-full border-collapse text-left">
            <thead className="text-fg-3">
              <tr><th className="pb-1 font-semibold">사유</th><th className="pb-1 text-right font-semibold">건수</th>
                <th className="pb-1 text-right font-semibold">최대 시도</th><th className="pb-1 text-right font-semibold">재시도 대기</th></tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {failures.map((failure) => (
                <tr key={failure.code} className="border-t border-line">
                  <td className="py-1.5">{failure.code}</td>
                  <td className="py-1.5 text-right">{failure.count.toLocaleString('ko-KR')}</td>
                  <td className="py-1.5 text-right">{failure.maxAttempts}회</td>
                  <td className="py-1.5 text-right">{failure.dueNow.toLocaleString('ko-KR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-fg-3">
            재시도 대기는 다시 볼 때가 이미 지난 건수입니다. 작업이 매 틱 밀린 실패와 처음 보는 글을
            번갈아 가져가므로 그대로 두어도 줄어듭니다. <span className="font-mono">timeout</span> 이 대부분이면
            게이트웨이가 느린 것이고, <span className="font-mono">invalid_output</span> 이 쌓이면 그 글 자체를 봐야 합니다.
          </p>
        </div>
      </dialog>
    </>
  );
}
