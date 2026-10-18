'use client';
import { useRouter } from 'next/navigation';
import { ConfirmAction } from '../components/ConfirmAction';
import { resultToast, useAdminToast } from '../components/Toast';
import { setSourceBufferAction } from './source-buffer-actions';

/** 원본 공급 조절 켜기·끄기 — 확인 창에서 사유를 꼭 적는다. 사유와 전·후 값은 작업 로그에 남는다(source-buffer-actions.ts) */
export function SourceBufferSwitch({ enabled, csrfToken, csrfExpiresAt }: { enabled: boolean; csrfToken: string; csrfExpiresAt: number }) {
  const router = useRouter();
  const toast = useAdminToast();
  return (
    <ConfirmAction
      title={enabled ? '원본 공급 조절을 끕니다' : '원본 공급 조절을 켭니다'}
      tone="neutral"
      confirmLabel={enabled ? '조절 끄기' : '조절 켜기'}
      summary={<ul>{enabled
        ? <><li>다음 수집 회차부터 새 원본 공급을 조절하지 않습니다 — 기본값(꺼짐)과 같은 방식입니다.</li><li>마지막 판정 기록은 지우지 않습니다.</li></>
        : <><li>다음 수집 회차부터, 후단(규칙·AI 1차·AI 2차·발행) 대기가 많으면 아직 원본을 받지 않은 새 저장소의 수집을 미룹니다(source_buffer). 이미 문서·후보가 있는 갱신은 계속합니다.</li>
          <li>판정은 대기 수 기준(count)입니다. 실측 처리율(R)은 아직 없습니다.</li>
          <li>검수·발행은 계속 처리합니다. 탐색 주기(seed)는 처음부터 다시 돌지 않습니다.</li></>}
        <li>열어 둔 크롤 설정 폼은 판이 바뀌어 다음 저장이 &ldquo;그 사이 바뀌었습니다&rdquo;로 거절됩니다.</li></ul>}
      note={{ label: '사유', maxLength: 500, placeholder: '왜 바꾸는지 적어 주세요' }}
      onConfirm={async ({ note }) => {
        const result = await setSourceBufferAction({ enabled: !enabled, expectedEnabled: enabled, reason: note ?? '', csrfToken, csrfExpiresAt });
        if (!result.error) {
          toast.show(resultToast(result, { message: result.message ?? '바꿨습니다', link: { label: '기록 보기', href: '/admin/activity' } }));
          router.refresh();
        }
        return result;
      }}
      trigger={(open) => <button type="button" className="admin-button" onClick={open}>{enabled ? '조절 끄기…' : '조절 켜기…'}</button>}
    />
  );
}
