import Link from "next/link";
import { hrefWith, metricHref, type BrowseState } from "@/components/home/browse-state";
import { Icon } from "@/components/home/icons";
import { categoryLabel } from "@/lib/domain/products/labels";
import { formatAsOfKst, TOOL_PERCENT_MIN, type HomePulse as Pulse } from "@/lib/domain/products/home-pulse";

function delta(value: number | null) {
  if (value === null) return null;
  return (
    <b className={`delta${value < 0 ? " negative" : ""}`}>
      {value >= 0 ? "↗ +" : "↘ "}
      {value.toFixed(1)}%
    </b>
  );
}

function Head({ title, metric, sub, state }: { title: string; metric: string; sub: string; state: BrowseState }) {
  return (
    <>
      <div className="stat-heading">
        <h2>{title}</h2>
        <Link className="info-btn" href={metricHref(state, metric)} aria-label={`${title} 집계 기준`}>
          <Icon name="info" size={14} />
        </Link>
      </div>
      <div className="stat-sub">{sub}</div>
    </>
  );
}

function toolMark(name: string, index: number) {
  if (/claude/i.test(name)) return { className: "claude", glyph: "✳" };
  if (/codex/i.test(name)) return { className: "codex", glyph: "⌘" };
  if (/cursor/i.test(name)) return { className: "cursor", glyph: "◈" };
  return { className: index === 0 ? "claude" : index === 1 ? "codex" : "cursor", glyph: name.slice(0, 1).toUpperCase() };
}

const TREND_ICONS = ["grid", "code", "pen"] as const;

export function HomePulse({ pulse, state }: { pulse: Pulse; state: BrowseState }) {
  const maxBar = Math.max(...pulse.launches.days.map((day) => day.count), 1);
  const tools = pulse.tools.rows.slice(0, 3);
  const trends = pulse.categories.filter((item) => item.qualified && (item.change ?? 0) > 0).slice(0, 3);
  const showToolPercent = pulse.tools.reported >= TOOL_PERCENT_MIN;

  return (
    <section aria-label="nomorevibe 활동 지표" id="pulse">
      <div className="pulse-top">
        <div className="section-eyebrow">
          <i className="small-dot" />
          NOMOREVIBE 안의 움직임
        </div>
        <div className="pulse-controls">
          <span className="snapshot-time">{formatAsOfKst(pulse.asOf)}</span>
          <Link className="text-button" href={metricHref(state, "all")}>집계 기준</Link>
        </div>
      </div>

      <div className="stats-grid" id="stats">
        <article className="stat-card">
          <Head title="최근 7일 출시" metric="launches" sub="최근 7일 · 신규 공개 프로젝트" state={state} />
          <div className="stat-number">
            <strong>{pulse.launches.current}</strong>
            <span>개</span>
            {delta(pulse.launches.change)}
          </div>
          <div
            className="bar-chart"
            role="img"
            aria-label={`최근 7일의 일별 출시 수: ${pulse.launches.days.map((day) => day.count).join(", ")}`}
          >
            {pulse.launches.days.map((day) => (
              <div className="bar-group" key={day.date}>
                <div
                  className="bar"
                  style={{ height: Math.max(2, (day.count / maxBar) * 32) }}
                  title={`${day.weekday}: ${day.count}개`}
                />
                <span className="bar-day">{day.weekday}</span>
              </div>
            ))}
          </div>
          <div className="stat-foot">
            <span>직전 7일 {pulse.launches.previous}개</span>
            <span className="foot-extra">업데이트 제외</span>
          </div>
        </article>

        <article className="stat-card">
          <Head title="메이커들의 제작 도구" metric="tools" sub="최근 30일 · 등록 프로젝트 기준" state={state} />
          {tools.length === 0 ? (
            <div className="empty-metric">어떤 도구로 만들었나요?<br />첫 도구 정보를 기다리고 있습니다.</div>
          ) : (
            <div className="tool-rows">
              {tools.map((tool, index) => {
                const mark = toolMark(tool.name, index);
                return (
                  <Link
                    key={tool.name}
                    className="tool-row"
                    href={hrefWith(state, { builder: tool.name, sort: "recent" })}
                    aria-label={`${tool.name}로 만든 프로젝트 보기`}
                  >
                    <span className={`tool-logo ${mark.className}`}>{mark.glyph}</span>
                    <span className="tool-name">{tool.name}</span>
                    <span className="tool-line">
                      <i style={{ width: `${tool.percent ?? 0}%` }} />
                    </span>
                    <span className="tool-num">{showToolPercent && tool.percent !== null ? `${tool.percent}%` : `${tool.count}개`}</span>
                  </Link>
                );
              })}
            </div>
          )}
          <div className="stat-foot">
            <span>응답 {pulse.tools.reported} / {pulse.tools.total}개 · 중복 선택</span>
            <span className="foot-extra">제작자 등록</span>
          </div>
        </article>

        <article className="stat-card">
          <Head title="관심이 커진 분야" metric="interest" sub="최근 7일 vs 직전 7일 · 제품별 고유 방문" state={state} />
          {trends.length === 0 ? (
            pulse.interestReady ? (
              <div className="empty-metric">최근 7일에 관심이 커진 분야가 없습니다.<br />감소·정체 분야는 집계 기준에서 확인할 수 있습니다.</div>
            ) : (
              <div className="empty-metric">관심 데이터를 모으고 있습니다.<br />두 비교 기간을 모두 수집한 뒤 증감률을 표시합니다.</div>
            )
          ) : (
            <div className="trend-rows">
              {trends.map((item, index) => (
                <Link
                  key={item.key}
                  className="trend-row"
                  href={hrefWith(state, { category: item.key, sort: "recent" })}
                >
                  <span className="trend-icon"><Icon name={TREND_ICONS[index]} size={14} /></span>
                  <span className="trend-label">
                    {categoryLabel(item.key)}
                    <small>제품별 고유 방문 {item.previous} → {item.current}건</small>
                  </span>
                  <span className="trend-value">{item.change! >= 0 ? "+" : ""}{item.change}%</span>
                </Link>
              ))}
            </div>
          )}
          <div className="stat-foot">
            <span>같은 방문자는 제품마다 기간별 1회 집계</span>
          </div>
        </article>

        <article className="stat-card">
          <Head title="최근 7일 업데이트" metric="updates" sub="최근 7일 · 새 릴리스를 공개한 프로젝트" state={state} />
          <div className="stat-number">
            <strong>{pulse.updates.projects}</strong>
            <span>개</span>
          </div>
          <div className="update-label">출시 이후에도, 계속 만드는 중.</div>
          <div className="release-activity" aria-hidden="true">
            <span className="release-icon">↻</span>
            {pulse.updates.projects > 0 && <span className="release-icon">✓</span>}
            {pulse.updates.projects > 0 && <span className="release-icon">＋</span>}
            {pulse.updates.projects > 0 && <span className="release-icon">…</span>}
          </div>
          <div className="stat-foot">
            <span>총 {pulse.updates.releases}건의 릴리스</span>
            <span className="foot-extra">프로젝트 중복 제외</span>
          </div>
        </article>
      </div>

      <div className="scope-note">
        <span>AI 업계 전체가 아닌, <b>nomorevibe 내부 활동</b></span>
        <span>관심은 저장 회원이 아니라 /go 제품별 고유 방문입니다</span>
      </div>
    </section>
  );
}
