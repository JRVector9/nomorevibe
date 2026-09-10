import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { getSettings } from "@/lib/crawl/settings";
import { recheckPublishedProducts, recheckableCount } from "@/lib/domain/products/recheck";
import { BanHits } from "./BanHits";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "발행분 재검수 — NoMoreVibe", robots: { index: false } };

/** 한 번에 다시 판정할 수. 원본을 읽으므로 무한정 늘리지 않는다 (실측 평균 2KB) */
const BATCH = 500;

/** 체크박스가 실릴 폼. 행 안에 폼을 겹칠 수 없어 form 속성으로 잇는다 */
const BAN_FORM = "recheck-ban";

export default async function RecheckPage({ searchParams }: {
  searchParams: Promise<{ offset?: string }>;
}) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const { offset: rawOffset } = await searchParams;
  const parsed = Number(rawOffset ?? 0);
  const offset = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;

  const settings = await getSettings();
  const [result, total] = await Promise.all([
    recheckPublishedProducts(settings, { limit: BATCH, offset }),
    recheckableCount(),
  ]);
  const next = offset + result.checked;
  const done = next >= total;

  return (
    <main className="mx-auto max-w-[900px] px-6 pb-20">
      <div className="flex flex-wrap items-baseline gap-3 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">발행분 재검수</h1>
        <span className="text-[13px] text-fg-3">
          {total.toLocaleString("ko-KR")}건 중 {(offset + 1).toLocaleString("ko-KR")}–{next.toLocaleString("ko-KR")} 확인
        </span>
      </div>

      <p className="mt-2 max-w-[68ch] text-[13.5px] leading-[1.7] text-fg-2">
        발행되면 규칙이 다시 닿지 않습니다. 기준을 고쳐도 이미 올라간 것은 그대로 남습니다.
        보관한 원본으로 <b className="font-semibold">지금 기준을 다시 태워</b> 거부로 갈리는 것을 짚습니다.
        저절로 내려가지는 않습니다 — 기준을 실험하다 공개 목록이 흔들리면 안 되므로,
        무엇을 내릴지는 아래에서 사람이 골라 누릅니다.
      </p>

      <div className="mt-5 rounded-[12px] border border-line bg-bg-card p-4">
        <p className="text-[13px] leading-[1.7] text-fg-2">
          이 범위에서 다시 판정한 <b className="font-semibold">{result.checked.toLocaleString("ko-KR")}건</b> 중{" "}
          <b className={`font-semibold ${result.hits.length ? "text-down" : "text-up"}`}>
            {result.hits.length.toLocaleString("ko-KR")}건
          </b>
          이 지금 기준으로는 거부입니다.
          {result.checked === 0 && " 원본이 남아 있는 발행분이 이 범위에 없습니다."}
        </p>
      </div>

      {result.hits.length > 0 && <BanHits formId={BAN_FORM} total={result.hits.length} />}

      {result.hits.length > 0 && (
        <ul className="mt-5 flex flex-col gap-3">
          {result.hits.map((hit) => (
            <li key={hit.slug} className="rounded-xl border border-line bg-bg-card p-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <label className="flex items-center gap-2 text-[14.5px] font-bold">
                  <input type="checkbox" form={BAN_FORM} name="slug" value={hit.slug} className="size-4 accent-[var(--down)]" />
                  {hit.name}
                </label>
                <a href={`https://github.com/${hit.repo}`} target="_blank" rel="noreferrer noopener"
                  className="font-mono text-[13px] text-fg-3 hover:text-accent">{hit.repo}</a>
                <Link href={`/admin/products/${hit.slug}`}
                  className="ml-auto rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-fg-2">
                  제품 화면
                </Link>
              </div>
              <a href={hit.url} target="_blank" rel="noreferrer noopener"
                className="mt-1.5 block break-all font-mono text-[13px] text-accent">{hit.url}</a>
              <p className="mt-2 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-[13px] leading-[1.7] text-fg-2">
                <b className="font-semibold text-down">{hit.stopped?.rule ?? hit.reason}</b>
                {hit.stopped ? <span className="ml-2 font-mono text-fg-3">{hit.stopped.detail}</span> : null}
              </p>
            </li>
          ))}
        </ul>
      )}

      <nav className="mt-6 flex flex-wrap items-center gap-2 text-[13px]">
        {offset > 0 && (
          <Link href={`/admin/products/recheck?offset=${Math.max(0, offset - BATCH)}`}
            className="rounded-lg border border-line px-3 py-2 font-semibold">이전 {BATCH}건</Link>
        )}
        {!done && result.checked > 0 && (
          <Link href={`/admin/products/recheck?offset=${next}`}
            className="rounded-lg border border-line px-3 py-2 font-semibold">다음 {BATCH}건</Link>
        )}
        {done && <span className="text-fg-3">끝까지 확인했습니다.</span>}
        <Link href="/admin/products" className="ml-auto py-2 text-fg-2">제품 목록으로</Link>
      </nav>
    </main>
  );
}
