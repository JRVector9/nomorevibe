import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { formatDetailTime } from "@/lib/format/time";
import { PageStamp } from "@/app/(operator)/admin/components/PageStamp";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { listExhaustedKeywordGenerations } from "@/lib/operations/keyword-generation-recovery";
import { KEYWORD_GENERATION_RECOVERY_HREF, stagePanelHref } from "@/lib/operations/stage-panel-catalog";
import { jobControlCsrf } from "../../status/job-control-csrf";
import { retryKeywordGenerationAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "키워드 생성 복구 — NoMoreVibe", robots: { index: false } };

export default async function KeywordGenerationRecoveryPage({ searchParams }: {
  searchParams: Promise<{ after?: string | string[]; result?: string | string[] }>;
}) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const { after, result } = await searchParams;
  const afterId = typeof after === "string" && /^\d{1,10}$/.test(after) && Number(after) <= 2_147_483_647 ? Number(after) : 0;
  const { rows, nextId } = await listExhaustedKeywordGenerations(afterId);
  const secret = authSecret();
  const token = secret && !adminWorkspaceReadOnly() ? jobControlCsrf(admin, secret) : null;

  return <main className="mx-auto max-w-4xl space-y-4 p-5"><PageStamp />
    <Link prefetch={false} href={stagePanelHref("keywords")} className="underline">키워드 등록 단계로</Link>
    <h1 className="text-[22px] font-semibold">키워드 생성 복구</h1>
    <p className="admin-page-lead text-fg-2">생성 한도에 걸린 제품을 한 건씩 다시 대기열에 넣을 수 있습니다. 생성에 성공할 때까지 기존 검색 키워드는 유지됩니다.</p>
    {result === "queued" && <p className="notice" role="status">키워드 생성을 한 번 더 요청했습니다.</p>}
    {result === "stale" && <p className="notice" role="status">제품의 상태가 바뀌었습니다. 현재 목록을 확인해 주세요.</p>}
    {result === "invalid" && <p className="notice" role="alert">요청을 확인하지 못했습니다. 다시 시도해 주세요.</p>}
    {!token && <p className="notice">현재는 읽기 전용입니다.</p>}
    {rows.length === 0 && <p>이 페이지에 생성 한도에 걸린 제품이 없습니다.</p>}
    <ul className="space-y-2">
      {rows.map(row => <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-4">
        <div>
          <Link prefetch={false} href={`/admin/products/${row.slug}`} className="font-medium underline">{row.name}</Link>
          <p className="text-sm text-fg-2">{row.errorCode === "invalid_output" && "출력 형식 오류 "}<code>{row.errorCode}</code>
            {" · "}기록된 시도 {row.attempts}회 · {formatDetailTime(row.updatedAt)}</p>
        </div>
        {token && <form action={retryKeywordGenerationAction}>
          <input type="hidden" name="productId" value={row.id} />
          <input type="hidden" name="sourceRevision" value={row.sourceRevision} />
          <input type="hidden" name="csrfToken" value={token} />
          <input type="hidden" name="csrfExpiresAt" value={admin.exp} />
          <button type="submit" className="button small" aria-label={`${row.name} 키워드 생성 한 번 더 시도`}>한 번 더 시도</button>
        </form>}
      </li>)}
    </ul>
    <nav aria-label="목록 페이지" className="flex gap-3">
      {afterId > 0 && <Link prefetch={false} href={KEYWORD_GENERATION_RECOVERY_HREF} className="button small">첫 페이지</Link>}
      {nextId !== null && <Link prefetch={false} href={`${KEYWORD_GENERATION_RECOVERY_HREF}?after=${nextId}`} className="button small">다음 페이지</Link>}
    </nav>
  </main>;
}
