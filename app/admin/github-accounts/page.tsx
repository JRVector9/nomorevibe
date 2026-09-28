import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { sql, and, eq } from "drizzle-orm";
import { currentAdmin } from "@/lib/auth/admin";
import { listGitHubCollectorAccounts } from "@/lib/crawl/github-accounts";
import { db } from "@/lib/db";
import { crawlDocuments, products } from "@/lib/db/schema";
import { TokenForm } from "./TokenForm";
import { toggleCollectorAccount } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "GitHub 수집 계정 — NoMoreVibe", robots: { index: false } };

export default async function GitHubAccountsPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const [accounts, documents, newProducts] = await Promise.all([
    listGitHubCollectorAccounts(),
    db.select({ count: sql<number>`count(*)::int` }).from(crawlDocuments).where(sql`${crawlDocuments.fetchedAt} >= now() - interval '1 hour'`),
    db.select({ count: sql<number>`count(*)::int` }).from(products).where(and(eq(products.source, "crawler"), sql`${products.createdAt} >= now() - interval '1 hour'`)),
  ]);
  const ready = (process.env.GITHUB_COLLECTOR_SECRET?.length ?? 0) >= 32;
  return <main className="mx-auto max-w-[1100px] px-6 pb-20">
    <div className="pt-6">
      <h1 className="text-[22px] font-extrabold tracking-tight">GitHub 수집 계정</h1>
      <p className="mt-2 text-[13px] leading-6 text-fg-2">계정마다 독립된 REST 한도가 있습니다. 같은 GitHub 계정의 토큰을 교체해도 한도는 추가되지 않습니다.</p>
    </div>

    <section className="mt-6 grid gap-3 sm:grid-cols-2" aria-label="최근 수집 결과">
      <div className="rounded-xl border border-line bg-bg-card p-4"><p className="text-[13px] text-fg-2">최근 1시간 원본 저장·갱신</p><strong className="mt-2 block text-[25px]">{(documents[0]?.count ?? 0).toLocaleString("ko-KR")}건</strong></div>
      <div className="rounded-xl border border-line bg-bg-card p-4"><p className="text-[13px] text-fg-2">최근 1시간 신규 수집 제품</p><strong className="mt-2 block text-[25px]">{(newProducts[0]?.count ?? 0).toLocaleString("ko-KR")}건</strong></div>
    </section>
    <p className="mt-2 text-[13px] text-fg-3">GitHub API 사용량은 해당 계정의 다른 앱 사용분도 포함합니다. 저장 건수와 API 요청 수는 서로 다른 값입니다.</p>

    <section className="mt-7" aria-label="등록된 계정">
      <h2 className="text-[17px] font-bold">등록된 계정 {accounts.length}개</h2>
      {accounts.length === 0 && <p className="mt-3 rounded-xl border border-line bg-bg-card p-4 text-[13px] text-fg-2">관리자에 등록된 계정이 없습니다. 기존 워커 환경 토큰은 이 목록에 표시되지 않습니다.</p>}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {accounts.map(account => {
          const quota = account.coreQuota;
          const observed = account.quotaObservedAt;
          const stale = account.quotaStale;
          return <article key={account.userId} className="rounded-xl border border-line bg-bg-card p-4">
            <div className="flex items-center justify-between gap-3"><h3 className="font-bold">{account.login}</h3><span className="text-[13px] text-fg-2">{account.enabled ? "활성" : "중지"}</span></div>
            <p className="mt-1 font-mono text-[13px] text-fg-3">GitHub 사용자 ID {account.userId}</p>
            {quota ? <p className="mt-4 text-[14px]">core 잔여 <strong>{quota.remaining.toLocaleString("ko-KR")}</strong> / {quota.limit.toLocaleString("ko-KR")} · 사용 {quota.used.toLocaleString("ko-KR")}</p>
              : <p className="mt-4 text-[13px] text-fg-2">한도 관측 없음</p>}
            <p className="mt-1 text-[13px] text-fg-3">{stale ? "한도 정보 오래됨 · " : ""}관측 {observed?.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) ?? "없음"} · 초기화 {quota ? new Date(quota.reset * 1000).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "알 수 없음"}</p>
            <form action={toggleCollectorAccount} className="mt-4">
              <input type="hidden" name="userId" value={account.userId} /><input type="hidden" name="enabled" value={account.enabled ? "false" : "true"} />
              <button className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold">{account.enabled ? "수집에서 제외" : "수집에 다시 사용"}</button>
            </form>
          </article>;
        })}
      </div>
    </section>

    <section className="mt-7"><TokenForm accounts={accounts.map(({ userId, login }) => ({ userId, login }))} ready={ready} /></section>
  </main>;
}
