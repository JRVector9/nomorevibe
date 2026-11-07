import Link from 'next/link';

/** Flow no longer owns a duplicate editor; point to the canonical screen. */
export function HumanModelSettings() {
  return <section className='grid gap-2 rounded-xl border border-line bg-bg-card p-3 text-[13px]'>
    <p className='text-fg-2'>사람 위임 모델은 고급 설정 › 사람 위임 모델에서 확인하고 바꿉니다. 흐름의 실제·설정 모델은 위 흐름 화면에 표시됩니다.</p>
    <Link href='/admin/models/human#human-review' prefetch={false} className='text-accent-ink underline'>사람 위임 모델 열기 →</Link>
  </section>;
}
