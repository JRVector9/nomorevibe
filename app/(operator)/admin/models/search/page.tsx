import { Suspense } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentAdmin } from '@/lib/auth/admin';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '@/lib/domain/products/embedding';
import { readSearchModelSettings, type SearchModelSettingsView } from '@/lib/domain/products/search-model-repository';
import { adminWorkspaceReadOnly } from '@/lib/operations/admin-workspace-preview';
import { PageStamp } from '../../components/PageStamp';
import { SearchModelSettingsForm } from './SearchModelSettingsForm';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: '검색 모델 설정 · 운영',
  robots: { index: false, follow: false },
};

function when(value: string | null | undefined): string {
  if (!value) return '기록 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}

async function SearchSettingsData({ readOnly, disabledReason }: { readOnly: boolean; disabledReason: string | null }) {
  let data: SearchModelSettingsView | null = null;
  try {
    data = await readSearchModelSettings({ probe: !readOnly });
  } catch {
    data = null;
  }
  if (!data) return <section role='alert' className='flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-bg-card p-5'>
    <h2 className='text-[18px] font-semibold'>검색 모델 설정을 읽지 못했습니다</h2>
    <p className='text-[13px] text-fg-2'>설정을 읽지 못했습니다. 잠시 후 다시 시도하세요.</p>
    <Link href='/admin/models/search' prefetch={false} className='text-[13px] underline'>다시 읽기</Link>
  </section>;
  return <>
    <section className='flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-bg-card p-5'>
      <div className='flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between'>
        <div>
          <h2 className='text-[18px] font-semibold'>검색 모델 실제 설정</h2>
          <p className='text-[13px] text-fg-2'>상태는 모델 목록 응답 기준이며, 추론 성공과는 구분합니다.</p>
        </div>
        <div className='text-[13px] text-fg-3'>
          <p>설정 읽음 <time dateTime={data.readAt}>{when(data.readAt)}</time></p>
          <p>모델 목록 관측 <time dateTime={data.observedAt}>{when(data.observedAt)}</time></p>
        </div>
      </div>
      <p className='text-[13px] text-fg-2'>저장 벡터 기준 {EMBEDDING_MODEL} · {EMBEDDING_DIMENSIONS}차원</p>
    </section>
    <SearchModelSettingsForm key={data.revision} revision={data.revision} connections={data.connections} embedding={data.embedding} rerank={data.rerank} disabledReason={disabledReason} />
    <section className='flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-bg-card p-5'>
      <div>
        <h2 className='text-[18px] font-semibold'>저장된 임베딩 벡터</h2>
      </div>
      {data.stored.length ? <div className='overflow-x-auto'>
        <table className='min-w-full text-left text-[13px]'>
          <thead><tr><th className='p-2'>모델</th><th className='p-2'>저장 벡터</th><th className='p-2'>최근 저장</th></tr></thead>
          <tbody>{data.stored.map(row => <tr key={row.model}>
            <td className='break-all p-2'>{row.model}</td>
            <td className='p-2'>{row.count.toLocaleString('ko-KR')}</td>
            <td className='p-2'>{when(row.latest)}</td>
          </tr>)}</tbody>
        </table>
      </div> : <p className='text-[13px] text-fg-2'>저장된 벡터 메타데이터가 없습니다.</p>}
    </section>
    <nav aria-label='관련 화면' className='flex flex-wrap gap-3 text-[13px]'>
      <Link href='/admin/models' prefetch={false} className='underline'>모델</Link>
      <Link href='/admin/flow' prefetch={false} className='underline'>흐름</Link>
      <Link href='/admin/models/tasks#connections' prefetch={false} className='underline'>AI 연결(주소·키 등록)</Link>
    </nav>
  </>;
}

export default async function SearchModelSettingsPage() {
  const admin = await currentAdmin();
  if (!admin) redirect('/admin/login');
  const readOnly = adminWorkspaceReadOnly();
  const dbOff = process.env.MODEL_SERVING_CONTRACTS_DB === '0';
  const disabledReason = readOnly ? '읽기 전용 미리보기에서는 저장할 수 없습니다.'
    : dbOff ? 'DB 모델 설정 읽기가 꺼져 있어 저장할 수 없습니다.' : null;
  return <main className='stack'>
    <PageStamp />
    <h1 className='sr-only'>검색 모델 설정</h1>
    <Suspense fallback={<section role='status' className='rounded-xl border border-line bg-bg-card p-5 text-[13px] text-fg-2'>검색 모델 설정을 읽는 중입니다.</section>}>
      <SearchSettingsData readOnly={readOnly} disabledReason={disabledReason} />
    </Suspense>
  </main>;
}
