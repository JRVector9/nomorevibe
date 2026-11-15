import { KOREAN_BROWSE_I18N, type BrowseI18n } from "@/lib/i18n/browse-i18n";
import { formatNumber } from "@/lib/i18n/format";
import type { PublicTeaser } from "@/lib/domain/products/public-teaser";
import { ActiveRows } from "./ActiveRows";

/**
 * 이번 주 가장 활발한 — 새 버전 수 상위 5, 막대 없이 번호·아이콘·이름·숫자만.
 * 서버는 차례·이름·링크만 넘긴다(2026-11-15 공개 HTML 이름·요약만) — 아이콘·분야·스타·새 버전 수는 ActiveRows 가 API 로 채운다.
 */
export function ActiveList({ rows, projects, i18n = KOREAN_BROWSE_I18N }: { rows: Pick<PublicTeaser, "slug" | "name">[]; projects: number; i18n?: BrowseI18n }) {
  const { locale, t } = i18n;
  const count = (n: number) => formatNumber(n, locale);
  return (
    <section className="active-list" aria-labelledby="active-title">
      <div className="row-head">
        <h2 id="active-title" className="row-title">{t("active.title")}</h2>
        <span className="row-note">{t("active.note")}</span>
      </div>
      {rows.length === 0 ? <p className="row-foot">{t("active.empty")}</p> : <ActiveRows rows={rows.slice(0, 5)} />}
      <p className="row-foot">{t("active.footer", { count: count(projects) })}</p>
    </section>
  );
}
