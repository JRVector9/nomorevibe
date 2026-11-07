import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { currentAdmin } from '@/lib/auth/admin';
import { PageStamp } from '../../components/PageStamp';
import { modelsAdvancedEditor } from '../../workspace-navigation';
import { AdvancedEditorLinks, advancedEditorTitle } from '../advanced/AdvancedEditorLinks';
import { HumanModelEditor } from './HumanModelEditor';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: advancedEditorTitle('human'),
  robots: { index: false, follow: false },
};
const EDITOR = modelsAdvancedEditor('human');

export default async function HumanModelsPage() {
  const admin = await currentAdmin();
  if (!admin) redirect('/admin/login');
  return <main className='stack'>
    <PageStamp />
    <header className='grid gap-1'>
      <AdvancedEditorLinks />
      <h1 className='text-[22px] font-semibold'>{EDITOR.label}</h1>
      <nav className='flex flex-wrap gap-3 text-[13px]' aria-label='관련 화면'>
        <Link href='/admin/flow' prefetch={false} className='text-accent-ink underline'>운영 홈 흐름</Link>
        <Link href='/admin/review?tab=human' prefetch={false} className='text-accent-ink underline'>사람 검토 큐</Link>
      </nav>
    </header>
    <Suspense fallback={<p role='status' className='small muted'>사람 위임 모델 설정을 불러오는 중…</p>}>
      <HumanModelEditor />
    </Suspense>
  </main>;
}
