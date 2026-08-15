import Link from "next/link";
import { getPublicList, type ProductListItem } from "@/lib/domain/products/view";
import { ProductIcon } from "@/components/ProductIcon";

export const dynamic = "force-dynamic";

// 홈은 가장 뜨거운 경로 — 전체 조회 대신 최근 N개만 (페이지네이션은 규모가 생기면)
const HOME_LIST_LIMIT = 100;

export default async function HomePage() {
  // 공개 목록에는 검증된 제품만 — 등록은 열고, 노출은 잠근다
  // DB 장애가 랜딩 전체를 500으로 만들지 않도록 폴백 처리
  let list: ProductListItem[] = [];
  let dbDown = false;
  try {
    list = await getPublicList(HOME_LIST_LIMIT);
  } catch {
    dbDown = true;
  }

  return (
    <main className="mx-auto max-w-[1280px] px-6 pb-20">
      <section className="pb-2 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">AI로 만든 제품들</h1>
        <p className="mt-1.5 text-fg-2">
          여기 있는 모든 제품은 AI로 만들어 배포된 실제 서비스입니다. 도메인 소유권이 검증된 제품만
          보여줍니다.
        </p>
      </section>

      {dbDown ? (
        <div className="mt-10 rounded-[14px] border border-line bg-bg-card p-12 text-center text-fg-3">
          일시적으로 목록을 불러올 수 없습니다. 잠시 후 다시 시도해주세요.
        </div>
      ) : list.length === 0 ? (
        <div className="mt-10 rounded-[14px] border border-line bg-bg-card p-12 text-center text-fg-3">
          아직 등록된 제품이 없습니다.{" "}
          <Link href="/launch" className="font-semibold text-accent">
            /nomorevibe
          </Link>{" "}
          로 첫 번째 제품을 등록해보세요.
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-[14px] border border-line">
          {list.map((p) => (
            <Link
              key={p.slug}
              href={`/p/${p.slug}`}
              className="flex items-center gap-4 border-b border-line bg-bg-card px-5 py-4 transition-colors last:border-b-0 hover:bg-bg-hover"
            >
              <ProductIcon name={p.name} ogImage={p.ogImage} size={44} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[14.5px] font-bold">{p.name}</span>
                  <span className="text-[11px] font-semibold text-up">✓ 검증됨</span>
                </div>
                <div className="mt-0.5 truncate text-xs text-fg-3">{p.tagline}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full border border-line bg-bg-soft px-2 py-0.5 text-[10.5px] font-semibold text-fg-2">
                    {p.category}
                  </span>
                  {p.builder && (
                    <span className="rounded-full border border-accent/35 bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold text-[#b8b0ff]">
                      ● {p.builder}
                      <span className="ml-1 font-normal text-fg-3">메이커 신고</span>
                    </span>
                  )}
                  {p.stack.slice(0, 4).map((s) => (
                    <span
                      key={s}
                      className="rounded-full border border-line bg-bg-soft px-2 py-0.5 text-[10.5px] font-semibold text-fg-2"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </div>
              <div className="hidden shrink-0 text-right text-xs text-fg-3 sm:block">
                {p.listedAt.toLocaleDateString("ko-KR", { month: "short", day: "numeric" })} 등록
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
