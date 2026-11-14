"use client";

import Link from "next/link";
import { hrefWith, type BrowseState } from "@/components/home/browse-state";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";

import type { HomePulse } from "@/lib/domain/products/home-pulse";

/**
 * 무엇으로 만들었나 — 공개 프로젝트 저장소에서 찾은 AI 코딩 도구 흔적.
 *
 * 알약은 흔적으로 거른다 — 메이커가 신고한 값은 별도의 `?builder=` 필터다.
 */
export function ToolsBoard({ tools, state }: { tools: HomePulse["tools"]; state: BrowseState }) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const count = (n: number) => formatNumber(n, locale);
  if (!tools || tools.rows.length === 0) return null;
  return (
    <section className="tools-board" aria-labelledby="tools-title">
      <div className="row-head">
        <div>
          <h2 id="tools-title" className="row-title">{t("tools.title")}</h2>
          <p className="row-note">{t("tools.note", { scanned: count(tools.scanned), found: count(tools.withTool) })}</p>
        </div>
      </div>
      <ul className="chips" data-track-filter="observedTool">
        {tools.rows.slice(0, 8).map((tool) => (
          <li key={tool.label}>
            <Link prefetch={false} href={hrefWith(state, { observedTool: tool.label }, locale)} className={`chip${state.observedTool === tool.label ? " chip-dark" : ""}`} aria-current={state.observedTool === tool.label ? "true" : undefined}>
              {tool.label} <span className="chip-count">{count(tool.count)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="row-foot">{t("tools.footer")}</p>
    </section>
  );
}
