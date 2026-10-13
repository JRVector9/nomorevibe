'use client';
import { useRouter } from 'next/navigation';
import { ConfirmAction } from '../components/ConfirmAction';
import { resultToast, useAdminToast } from '../components/Toast';
import { setCollectionEnabled } from './actions';
import { COLLECTION_OFF_REASONS, COLLECTION_ON_REASONS } from './collection-reasons';

/**
 * 수집 켜기·끄기 — 운영센터 머리에서 바로(2026-10-08 UX 감사 ADM-18).
 *
 * 전에는 4,600px 설정 폼 맨 위 스위치를 누르고 맨 아래까지 내려가 저장해야 했고, 다른 설정 저장과 한 묶음이었다.
 * 확인 창에서 사유를 꼭 고르고(기타면 메모), 누르면 enabled 하나만 곧바로 바뀐다. 사유는 작업 로그에 남는다.
 */
export function CollectionSwitch({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const toast = useAdminToast();
  return (
    <ConfirmAction
      title={enabled ? '수집을 끕니다' : '수집을 켭니다'}
      tone={enabled ? 'danger' : 'neutral'}
      confirmLabel={enabled ? '수집 끄기' : '수집 켜기'}
      summary={<ul>{enabled
        ? <><li>다음 예약부터 새 레포 탐색·수집·판정을 멈춥니다.</li><li>이미 공개된 제품과 다른 설정은 그대로입니다.</li></>
        : <><li>다음 예약부터 탐색·수집·판정을 다시 돌립니다.</li><li>다른 설정은 그대로입니다.</li></>}</ul>}
      reasons={{ label: enabled ? '끄는 사유' : '켜는 사유', options: enabled ? COLLECTION_OFF_REASONS : COLLECTION_ON_REASONS }}
      note={{ label: '메모', optional: true, maxLength: 500, placeholder: '기타를 골랐으면 꼭 적어 주세요' }}
      onConfirm={async ({ reason, note }) => {
        const result = await setCollectionEnabled({ enabled: !enabled, reason: reason ?? '', note });
        if (!result.error) {
          toast.show(resultToast(result, { message: result.message ?? '바꿨습니다', link: { label: '기록 보기', href: '/admin/activity' } }));
          router.refresh();
        }
        return result;
      }}
      trigger={(open) => (
        <button type="button" role="switch" aria-checked={enabled} className="ops-collection" data-on={enabled || undefined} onClick={open}
          title={enabled ? '눌러서 수집을 끕니다(사유 필요)' : '눌러서 수집을 켭니다(사유 필요)'}>
          <span aria-hidden className="ops-collection-track"><span /></span>수집 {enabled ? '켜짐' : '꺼짐'}
        </button>
      )}
    />
  );
}
