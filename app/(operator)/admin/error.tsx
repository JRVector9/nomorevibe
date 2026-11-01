"use client";

import Link from "next/link";
import { useRenderRecovery } from "@/components/errors/RenderReadRecovery";

/** Keep the admin navigation available when an individual page cannot render. */
export default function AdminError({ error, retry }: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useRenderRecovery(Boolean(error.digest));
  return <main className="mx-auto max-w-3xl space-y-4 px-5 py-12">
    <h1 className="text-[22px] font-semibold">화면을 불러오지 못했습니다</h1>
    <p className="text-[14px] leading-6 text-fg-2">잠시 후 다시 시도해 주세요. 처리 결과가 불확실한 작업은 작업 로그에서 확인해 주세요.</p>
    <div className="flex flex-wrap gap-4">
      <button type="button" onClick={() => retry()} className="min-h-11 rounded-lg border border-line px-4 text-[14px]">다시 시도</button>
      <Link prefetch={false} href="/admin/activity" className="inline-flex min-h-11 items-center text-[14px] underline">작업 로그</Link>
    </div>
    {error.digest && <p className="text-[13px] text-fg-2">오류 참조: {error.digest}</p>}
  </main>;
}
