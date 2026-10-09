import Link from "next/link";
import { ProductIcon } from "@/components/ProductIcon";
import { formatCount } from "@/lib/format/number";
import { categoryLabel } from "@/lib/domain/products/labels";
import type { HomePulse } from "@/lib/domain/products/home-pulse";

/** 이번 주 가장 활발한 — 새 버전 수 상위 5, 막대 없이 번호·아이콘·이름·숫자만 */
export function ActiveList({ active, projects }: { active: HomePulse["active"]; projects: number }) {
  const rows = active.slice(0, 5);
  return (
    <section className="active-list" aria-labelledby="active-title">
      <div className="row-head">
        <h2 id="active-title" className="row-title">이번 주 가장 활발한</h2>
        <span className="row-note">새 버전 수 · 7일</span>
      </div>
      {rows.length === 0 ? (
        <p className="row-foot">최근 7일에 새 버전을 낸 프로젝트가 없습니다.</p>
      ) : (
        <ol className="rank-list">
          {rows.map((item, index) => (
            <li key={item.slug} className="rank-row">
              <span className="rank-no">{index + 1}</span>
              <ProductIcon name={item.name} ogImage={item.ogImage} size={28} />
              <span className="rank-name">
                <Link prefetch={false} href={`/p/${item.slug}`}>{item.name}</Link>
                <small>{categoryLabel(item.category)}{item.stars !== null && item.stars >= 100 ? ` · ★ ${formatCount(item.stars)}` : ""}</small>
              </span>
              <b className="rank-value">{formatCount(item.releases)}건</b>
            </li>
          ))}
        </ol>
      )}
      <p className="row-foot">새 버전을 낸 {formatCount(projects)}개 중 상위 5 · 새 버전 = GitHub 릴리스·제작자 업데이트</p>
    </section>
  );
}
