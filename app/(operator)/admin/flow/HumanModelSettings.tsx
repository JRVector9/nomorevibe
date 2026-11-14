import Link from 'next/link';
import { HumanModelEditor } from '../models/human/HumanModelEditor';

/** Home embeds the canonical editor and its authenticated/CAS actions; it never owns another model setting. */
export async function HumanModelSettings({ readOnly = false }: { readOnly?: boolean } = {}) {
  return <div className='grid min-w-0 gap-3 text-[13px]'>
    <p className='text-fg-2'>맡길 모델을 저장한 뒤 자동 위임을 켜세요. 근거와 확신 기준을 충족한 승인은 기존 최종 발행 검사로 이어집니다.</p>
    <HumanModelEditor scope='human-review' readOnly={readOnly} />
    <p><Link href='/admin/models/human#human-review' prefetch={false} className='text-accent-ink underline'>관련 위임 모델 설정 전체 보기 →</Link></p>
  </div>;
}
