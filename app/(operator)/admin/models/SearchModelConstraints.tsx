import Link from 'next/link';
import type { ModelServerHealth } from '@/lib/operations/model-servers';

/** 실제 설정과 서버 메타데이터 응답만 표시한다. 실제 추론 성공이나 벡터 공간 증명을 대신하지 않는다. */
export function SearchModelConstraints({ health, embeddingModel, dimensions, probedAgo }: {
  health: ModelServerHealth[]; embeddingModel: string; dimensions: number;
  /** 이 렌더의 자동 확인 결과가 관측 표(probe:search-server:…)에 남은 시점 설명 — 한 화면이 넘긴다 */
  probedAgo?: string | null;
}) {
  const rowOf = (name: ModelServerHealth['name']) => health.find(item => item.name === name);
  const state = (name: ModelServerHealth['name']) => {
    const row = rowOf(name);
    if (!row) return '연결 환경 미설정';
    if (row.probeKind === 'models') return row.ok ? '모델 목록 응답 확인' : `모델 목록 확인 실패 · ${row.error ?? '미확인'}`;
    return row.ok ? '서버 /health 응답 확인' : `서버 확인 실패 · ${row.error ?? '미확인'}`;
  };
  const detail = (name: ModelServerHealth['name']) => {
    const row = rowOf(name);
    if (row?.source === 'configured') return <>{row.baseUrl?.trim() || 'API 미확인'} · 모델 {row.model?.trim() || '미확인'} · 저장 설정</>;
    if (name === '임베딩') return <>{embeddingModel} · {dimensions}차원 · 환경 변수</>;
    return <>환경 변수 · 서버 /health 기준 · 모델 식별자 미확인</>;
  };
  return <section className='flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-bg-card p-5' aria-labelledby='search-model-heading'>
    <h2 id='search-model-heading' className='text-[18px] font-semibold'>검색 모델 · 임베딩·재정렬</h2>
    <p className='text-[13px] text-fg-2'>서버 상태는 /health 또는 모델 목록 응답 기준입니다.{probedAgo ? ` 확인 자동(렌더) · ${probedAgo}.` : ''}</p>
    <dl className='grid min-w-0 gap-3 text-[13px] sm:grid-cols-2'>
      <div className='min-w-0 rounded-lg border border-line p-3'><dt className='font-semibold'>의미 검색 임베딩</dt>
        <dd className='break-all'>{detail('임베딩')}</dd><dd>{state('임베딩')}</dd></div>
      <div className='min-w-0 rounded-lg border border-line p-3'><dt className='font-semibold'>검색 결과 재정렬</dt>
        <dd className='break-all'>{detail('재정렬')}</dd><dd>{state('재정렬')}</dd></div>
    </dl>
    <p className='text-[13px] text-fg-2'><Link href='/admin/models/search' prefetch={false} className='underline'>검색 모델 설정 열기</Link></p>
    <p className='text-[13px] text-fg-3'>제품·검색어 벡터 API는 함께 설정하고 기존 벡터 32개와 호환성을 확인합니다. 재정렬은 저장할 때 응답을 확인합니다.</p>
  </section>;
}
