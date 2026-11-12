'use client';

import { ConfirmAction } from '../../components/ConfirmAction';
import { useAdminToast } from '../../components/Toast';
import { undoHumanBatchAction } from './actions';

/**
 * 일괄 결정 기록의 「묶음째 되돌리기」 — 묶음이 결정한 건마다 기존 되돌리기(undoAdminDecision)를 부른다.
 * 결정 뒤 발행·판정이 손댄 건은 돌아가지 않고 사유가 남는다(그 건은 제품 관리에서). 한 묶음은 한 번만 되돌린다.
 */
export function UndoBatch({ gateId, title, count }: { gateId: number; title: string; count: number }) {
  const toast = useAdminToast();
  return <ConfirmAction title={`${title} ${count.toLocaleString('ko-KR')}건을 결정 앞 상태로 되돌립니다`}
    summary={<ul className="hb-confirm">
      <li>결정한 건마다 심사 큐의 「되돌리기」와 같은 동작을 부릅니다.</li>
      <li>결정 뒤 발행 워커가 이미 올렸거나 다시 판정한 건은 되돌리지 못하고 사유를 남깁니다 — 이미 공개된 건은 제품 관리에서 내립니다.</li>
      <li>한 묶음은 한 번만 되돌립니다.</li>
    </ul>}
    confirmLabel="묶음째 되돌리기" tone="danger"
    onConfirm={async () => {
      const result = await undoHumanBatchAction(gateId);
      if ('error' in result) return result;
      toast.show({ message: result.message, tone: 'ok' });
      return null;
    }}
    trigger={open => <button type="button" className="button small" onClick={open}>묶음째 되돌리기</button>} />;
}
