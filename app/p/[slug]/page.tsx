/* eslint-disable @next/next/no-img-element -- OG 스냅샷은 크기를 미리 알 수 없는 동적 이미지라 next/image 최적화 대상이 아님 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { findBySlug } from "@/lib/domain/products/repository";
import { ProductIcon } from "@/components/ProductIcon";
import { StatusBadge, BuilderBadge } from "@/components/TrustBadges";
import { isUnclaimed, builderClaimOf } from "@/lib/domain/products/view";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

async function getProduct(slug: string) {
  const product = await findBySlug(slug);
  if (!product || product.status === "banned") return null;
  return product;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) return {};
  return {
    title: `${product.name} — NoMoreVibe`,
    description: product.tagline,
    // 미검증 제품은 검색엔진에 노출하지 않는다
    robots: product.status === "verified" ? undefined : { index: false, follow: false },
  };
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) notFound();

  const displayUrl = product.url.replace(/^https?:\/\//, "");
  const unclaimed = isUnclaimed(product);

  return (
    <main className="mx-auto max-w-[1180px] px-6 pb-20">
      <div className="pt-[18px] text-[12.5px] text-fg-3">
        <Link href="/" className="hover:text-fg">
          Products
        </Link>{" "}
        › {product.category} › {product.name}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-7 md:grid-cols-[1fr_320px]">
        {/* 왼쪽 */}
        <div>
          <div className="flex items-start gap-[18px]">
            <ProductIcon name={product.name} ogImage={product.ogImage} size={64} />
            <div className="min-w-0">
              <h1 className="flex flex-wrap items-center gap-3 text-[26px] font-extrabold tracking-tight">
                {product.name}
                <StatusBadge status={product.status} unclaimed={unclaimed} size="md" />
              </h1>
              <div className="mt-1 text-[14.5px] text-fg-2">{product.tagline}</div>
              <a
                href={product.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-[13px] font-semibold text-accent hover:underline"
              >
                {displayUrl} ↗
              </a>
            </div>
          </div>

          {product.ogImage && (
            <div className="mt-6 overflow-hidden rounded-[14px] border border-line bg-bg-card">
              <div className="flex items-center gap-1.5 border-b border-line bg-bg-soft px-3.5 py-2">
                <span className="h-[9px] w-[9px] rounded-full bg-[#ea3943]" />
                <span className="h-[9px] w-[9px] rounded-full bg-[#f6b73c]" />
                <span className="h-[9px] w-[9px] rounded-full bg-[#16c784]" />
                <span className="ml-2 rounded-md bg-bg px-2.5 py-0.5 font-mono text-[11px] text-fg-3">
                  {displayUrl}
                </span>
                <span className="ml-auto text-[10.5px] text-fg-3">등록 시점 OG 이미지</span>
              </div>
              <img src={product.ogImage} alt={`${product.name} 미리보기`} className="w-full" />
            </div>
          )}

          <div className="mt-6 rounded-[14px] border border-line bg-bg-card p-[22px]">
            <h2 className="text-[15px] font-bold">
              소개 <span className="ml-1 text-[11px] font-medium text-fg-3">— 등록 시 AI가 작성</span>
            </h2>
            <p className="mt-4 whitespace-pre-line text-[13.5px] leading-[1.7] text-fg-2">
              {product.description}
            </p>
          </div>
        </div>

        {/* 오른쪽 사이드바 */}
        <div>
          <div className="rounded-[14px] border border-line bg-bg-card p-[22px]">
            <h2 className="text-[15px] font-bold">
              Product Info{" "}
              <span className="ml-1 text-[11px] font-medium text-fg-3">
                {unclaimed ? "공개 저장소에서 수집" : "from /nomorevibe"}
              </span>
            </h2>
            <dl className="mt-3">
              {product.makerName && (
                <InfoRow k="메이커" v={<>{product.makerName} <span className="text-[11px] text-fg-3">(미검증)</span></>} />
              )}
              <InfoRow
                k="등록일"
                v={product.createdAt.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" })}
              />
              {product.builder && (
                <InfoRow
                  k="만든 AI"
                  v={<BuilderBadge builder={product.builder} claim={builderClaimOf(product)} />}
                />
              )}
              {(product.stack ?? []).length > 0 && (
                <InfoRow
                  k="스택"
                  v={
                    <span className="flex flex-wrap justify-end gap-1">
                      {(product.stack ?? []).map((s) => (
                        <span
                          key={s}
                          className="rounded-full border border-line bg-bg-soft px-2 py-0.5 text-[10.5px] font-semibold text-fg-2"
                        >
                          {s}
                        </span>
                      ))}
                    </span>
                  }
                />
              )}
              <InfoRow k="카테고리" v={product.category} />
              {/* http(s)만 렌더 — 서버 검증에 더한 심층 방어 */}
              {product.repoUrl && /^https?:\/\//i.test(product.repoUrl) && (
                <InfoRow
                  k="레포"
                  v={
                    <a
                      href={product.repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline"
                    >
                      {product.repoUrl.replace(/^https?:\/\/(www\.)?/, "")} ↗
                    </a>
                  }
                />
              )}
            </dl>
          </div>

          {unclaimed && (
            <div className="mt-5 rounded-[14px] border border-accent bg-accent-soft p-[22px]">
              <h2 className="text-[15px] font-bold">이 제품의 주인이신가요?</h2>
              <p className="mt-3 text-[12.5px] leading-[1.7] text-fg-2">
                공개 저장소에서 찾아 저희가 대신 올린 제품입니다. 여기 적힌 정보는 저희가 추정한
                것이라 사실과 다를 수 있습니다.
              </p>
              <p className="mt-3 text-[12.5px] leading-[1.7] text-fg-2">
                프로젝트 폴더에서 <code className="font-mono text-accent">/nomorevibe</code> 를
                실행하면 소유권을 확인하고 직접 수정하실 수 있습니다. 원치 않으시면 내려드립니다.
              </p>
            </div>
          )}

          {product.status === "unverified" && (
            <div className="mt-5 rounded-[14px] border border-line bg-bg-card p-[22px]">
              <h2 className="text-[15px] font-bold">아직 공개 목록에 없습니다</h2>
              <p className="mt-3 text-[12.5px] leading-[1.7] text-fg-2">
                도메인 소유권을 검증하면 공개 목록에 게시됩니다. 프로젝트 폴더에서{" "}
                <code className="font-mono text-accent">/nomorevibe verify</code> 를 실행하세요.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function InfoRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line py-2.5 text-[13px] last:border-b-0">
      <dt className="shrink-0 text-fg-3">{k}</dt>
      <dd className="min-w-0 text-right font-semibold">{v}</dd>
    </div>
  );
}
