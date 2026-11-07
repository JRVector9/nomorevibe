import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { currentAdmin } from '@/lib/auth/admin';
import { PageStamp } from '../../components/PageStamp';
import { HumanModelEditor } from './HumanModelEditor';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '사람 확인 · AI 위임 모델',
  robots: { index: false, follow: false },
};

export default async function HumanModelsPage() {
  const admin = await currentAdmin();
  if (!admin) redirect('/admin/login');
  return <main className='stack'>
    <PageStamp />
    <h1 className='sr-only'>사람 확인 · AI 위임 모델</h1>
    <nav className='flex flex-wrap gap-3 text-[13px]'>
      <Link href='/admin/models' prefetch={false} className='text-accent-ink underline'>LLM 운영</Link>
      <Link href='/admin/flow' prefetch={false} className='text-accent-ink underline'>크롤 흐름</Link>
      <Link href='/admin/review?tab=human' prefetch={false} className='text-accent-ink underline'>사람 검토 큐</Link>
    </nav>
    <Suspense fallback={<p role='status' className='small muted'>사람 확인 · AI 위임 설정을 불러오는 중…</p>}>
      <HumanModelEditor />
    </Suspense>
  </main>;
}
