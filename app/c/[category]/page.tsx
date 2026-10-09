import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { HomeScreen, type HomeParams } from "@/app/page";
import { browseTitle, categoryRedirect, categorySlug, parseCategory } from "@/components/home/browse-state";
import { pageTitle } from "@/lib/copy/brand";
import { categoryLabel } from "@/lib/domain/products/labels";
import { hiddenByDefault } from "@/lib/domain/products/visibility";
import { CategoryLinks } from "./CategoryLinks";

export const dynamic = "force-dynamic";

/**
 * 분야 화면 — /c/finance 가 정식 주소다(2026-10-08 UX 감사 UX-40, 계약 C4). 홈과 같은 목록을 그 분야로 거른다.
 *
 * - 대문자가 섞이면(/c/Finance) 소문자 주소로 보낸다. 옛 주소 /?category=… 도 홈이 여기로 보낸다.
 * - 모르는 분야는 '없는 분야입니다'(not-found.tsx).
 * - 기본 목록에서 빼는 분야(개인 프로필, 계약 C3)는 목록 대신 왜 없는지 말한다 — 검색에 싣지 않는다(noindex).
 */
type Props = {
  params: Promise<{ category: string }>;
  searchParams: Promise<HomeParams>;
};

const queryOf = (params: HomeParams) => {
  const value = Array.isArray(params.q) ? params.q[0] : params.q;
  return value?.trim().slice(0, 200) || undefined;
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ category: raw }, search] = await Promise.all([params, searchParams]);
  const category = parseCategory(raw);
  if (!category) return { title: pageTitle("없는 분야"), robots: { index: false, follow: true } };
  if (hiddenByDefault(category)) return { title: pageTitle(`${categoryLabel(category)} 프로젝트`), robots: { index: false, follow: true } };
  return { title: browseTitle({ query: queryOf(search), category }) };
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const [{ category: raw }, search] = await Promise.all([params, searchParams]);
  const category = parseCategory(raw);
  if (!category) notFound();
  // 정식 주소는 소문자 하나 — 나머지 조건은 그대로 붙여 보낸다(홈의 옛 주소와 같은 규칙)
  if (raw !== categorySlug(category)) redirect(categoryRedirect({ ...search, category }) ?? `/c/${categorySlug(category)}`);
  if (hiddenByDefault(category)) return <HiddenCategory label={categoryLabel(category)} />;
  return HomeScreen({ params: { ...search, category } });
}

/** 기본 목록에서 뺀 분야 — 지운 것이 아니라 본인이 등록·확인한 것만 보인다(운영자 결정 D2) */
function HiddenCategory({ label }: { label: string }) {
  return (
    <main className="wrap">
      <section className="feed" aria-labelledby="category-hidden-title">
        <div className="empty-state">
          <h1 id="category-hidden-title" className="row-title">{label} 분야는 목록에 싣지 않습니다</h1>
          <p>
            개인 포트폴리오·이력 페이지는 본인이 직접 등록하거나 운영자 확인을 마친 경우에만 보입니다.{" "}
            <Link prefetch={false} href="/policy#excluded">게재 기준</Link>
          </p>
          <CategoryLinks />
          <Link prefetch={false} href="/" className="secondary">홈으로</Link>
        </div>
      </section>
    </main>
  );
}
