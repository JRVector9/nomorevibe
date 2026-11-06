'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState } from 'react';
import type { AiConnectionView } from '@/lib/operations/admin-ai-tasks';
import type { SearchModelServiceView } from '@/lib/domain/products/search-model-repository';
import { saveSearchModelSettingsAction, type SearchModelActionState } from './actions';

type Kind = 'embedding' | 'rerank';

const SOURCE: Record<SearchModelServiceView['source'], string> = { environment: '환경 변수', configured: '저장 설정' };
const STATUS: Record<SearchModelServiceView['status'], string> = { configured: '목록 응답 확인', environment: '목록 응답 확인', unconfigured: '미설정', error: '오류', unobserved: '조회 생략' };

function CurrentService({ service }: { service: SearchModelServiceView }) {
  return <dl className='grid min-w-0 gap-2 rounded-lg border border-line p-3 text-[12px] sm:grid-cols-2'>
    <div><dt className='font-semibold'>현재 출처</dt><dd>{SOURCE[service.source]}</dd></div>
    <div><dt className='font-semibold'>현재 상태</dt><dd>{STATUS[service.status]}</dd></div>
    <div className='sm:col-span-2'><dt className='font-semibold'>현재 API</dt><dd className='break-all'>{service.baseUrl.trim() || '미설정'}</dd></div>
    <div className='sm:col-span-2'><dt className='font-semibold'>현재 모델</dt><dd className='break-all'>{service.model?.trim() || '미확인'}</dd></div>
    {service.error && <div className='sm:col-span-2'><dt className='font-semibold'>확인할 내용</dt><dd>{service.error}</dd></div>}
  </dl>;
}

function ServiceForm({ kind, revision, connections, current, disabledReason }: {
  kind: Kind; revision: string; connections: readonly AiConnectionView[]; current: SearchModelServiceView; disabledReason: string | null;
}) {
  const [connectionId, setConnectionId] = useState('');
  const [model, setModel] = useState('');
  const [state, formAction, pending] = useActionState(saveSearchModelSettingsAction, null);
  const router = useRouter();
  const refreshed = useRef<SearchModelActionState>(null);
  useEffect(() => {
    if (state?.ok && refreshed.current !== state) {
      refreshed.current = state;
      router.refresh();
    }
  }, [state, router]);
  const apiConnections = connections.filter(connection => connection.kind === 'api' && connection.enabled);
  const selected = apiConnections.find(connection => connection.id === connectionId) ?? null;
  const models = selected?.models ?? null;
  const issues = state?.issues ?? [];
  const success = state?.ok ? state.message ?? null : null;
  const locked = Boolean(disabledReason);
  const canSave = !locked && !pending && Boolean(connectionId) && Boolean(model);
  const title = kind === 'embedding' ? '의미 검색 임베딩' : '검색 결과 재정렬';
  const buttonText = kind === 'embedding' ? '호환성 확인·저장' : '응답 확인·저장';
  const guidance = kind === 'embedding'
    ? '저장 시 기존 벡터 32개와 호환성을 확인하고 제품·검색어 API를 함께 적용합니다.'
    : '저장 시 실제 재정렬 응답을 확인합니다.';
  return <section className='flex min-w-0 flex-col gap-3 rounded-lg border border-line p-3' aria-labelledby={`search-${kind}-heading`}>
    <div>
      <h3 id={`search-${kind}-heading`} className='text-[15px] font-semibold'>{title}</h3>
      <CurrentService service={current} />
    </div>
    {disabledReason && <p role='note' className='text-[12px] text-fg-2'>{disabledReason}</p>}
    {!apiConnections.length && <p className='text-[12px] text-fg-2'>사용 가능한 API 연결이 없습니다. <Link href='/admin/models/tasks#connections' prefetch={false} className='underline'>AI 연결에서 주소·키 등록</Link></p>}
    <form action={formAction} className='flex flex-col gap-2 rounded-lg border border-line p-3'>
      <input type='hidden' name='revision' value={revision} />
      <input type='hidden' name='kind' value={kind} />
      <input type='hidden' name='connectionId' value={connectionId} />
      <input type='hidden' name='model' value={model} />
      <label htmlFor={`${kind}-connection`} className='text-[12px] font-semibold'>API 연결</label>
      <select id={`${kind}-connection`} value={connectionId} onChange={event => { setConnectionId(event.target.value); setModel(''); }} disabled={locked || pending} className='min-w-0 rounded-lg border border-line bg-bg-card px-3 py-2 text-[13px]'>
        <option value=''>연결 선택</option>
        {apiConnections.map(connection => <option key={connection.id} value={connection.id}>{connection.label}{connection.hasKey ? '' : ' · 키 없음'}</option>)}
      </select>
      <label htmlFor={`${kind}-model`} className='text-[12px] font-semibold'>서버 모델</label>
      <select id={`${kind}-model`} value={model} onChange={event => setModel(event.target.value)} disabled={locked || pending || !selected || !models} className='min-w-0 rounded-lg border border-line bg-bg-card px-3 py-2 text-[13px]'>
        <option value=''>{!connectionId ? '연결을 먼저 선택' : models ? '모델 선택' : '모델 목록 미확인'}</option>
        {models?.map(entry => <option key={entry.id} value={entry.id}>{entry.id}</option>)}
      </select>
      {selected && !models && <p className='text-[12px] text-fg-2'>이 연결의 실제 모델 목록이 없습니다. <Link href='/admin/models/tasks#connections' prefetch={false} className='underline'>AI 연결에서 목록을 읽으세요.</Link></p>}
      <p className='text-[12px] text-fg-3'>{guidance}</p>
      <button type='submit' disabled={!canSave} className='self-start rounded-lg border border-line px-3 py-2 text-[13px] font-semibold disabled:opacity-50'>{pending ? '확인 중…' : buttonText}</button>
      {issues.length > 0 && <ul role='alert' className='list-disc pl-5 text-[12px] text-fg-2'>{issues.map((issue, index) => <li key={`${index}:${issue}`}>{issue}</li>)}</ul>}
      {success && <p role='status' aria-live='polite' className='text-[12px] text-fg-2'>{success}</p>}
    </form>
  </section>;
}

type Props = {
  revision: string; connections: readonly AiConnectionView[]; embedding: SearchModelServiceView; rerank: SearchModelServiceView; disabledReason: string | null;
};

export function SearchModelSettingsForm({ revision, connections, embedding, rerank, disabledReason }: Props) {
  return <section className='flex min-w-0 flex-col gap-3' aria-labelledby='search-model-settings-heading'>
    <div>
      <h2 id='search-model-settings-heading' className='text-[18px] font-semibold'>검색 모델 설정 저장</h2>
      <p className='text-[13px] text-fg-2'>제품·검색어 벡터는 같은 API를 사용합니다.</p>
    </div>
    <div className='grid min-w-0 gap-3 xl:grid-cols-2'>
      <ServiceForm kind='embedding' revision={revision} connections={connections} current={embedding} disabledReason={disabledReason} />
      <ServiceForm kind='rerank' revision={revision} connections={connections} current={rerank} disabledReason={disabledReason} />
    </div>
  </section>;
}
