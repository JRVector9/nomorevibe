import Link from "next/link";
import { hrefWith, metricHref, type BrowseState } from "@/components/home/browse-state";
import { Icon } from "@/components/home/icons";
import { categoryLabel } from "@/lib/domain/products/labels";
import { formatAsOfKst, type HomePulse as Pulse } from "@/lib/domain/products/home-pulse";

const num = (value: number) => value.toLocaleString("ko-KR");

function Bar({ value, top }: { value: number; top: number }) {
  return (
    <span className="board-bar" aria-hidden="true">
      <i style={{ width: `${Math.max(3, (value / Math.max(top, 1)) * 100)}%` }} />
    </span>
  );
}

function Board({ title, metric, pill, foot, state, children }: {
  title: string;
  metric: string;
  pill: React.ReactNode;
  foot: React.ReactNode;
  state: BrowseState;
  children: React.ReactNode;
}) {
  return (
    <article className="board">
      <div className="board-head">
        <h2>{title}</h2>
        <span className="board-pill">{pill}</span>
        <Link className="info-btn" href={metricHref(state, metric)} aria-label={`${title} 집계 기준`}>
          <Icon name="info" size={14} />
        </Link>
      </div>
      {children}
      <p className="board-foot">{foot}</p>
    </article>
  );
}

/**
 * 홈 리더보드 — 한 줄에 하나, 곁정보는 이름 옆에.
 *
 * 윗줄(메뉴 위 띠)이 이번 주 숫자를 싣고, 여기는 그 숫자 안의 순위를 싣는다. 검색·필터와
 * 분리된 전역 내부 집계다.
 */
export function HomePulse({ pulse, state }: { pulse: Pulse; state: BrowseState }) {
  const topActive = pulse.active[0]?.releases ?? 0;
  const categories = pulse.categories.filter((item) => item.key !== "Other").slice(0, 10);
  const other = pulse.categories.find((item) => item.key === "Other")?.total ?? 0;
  const topCategory = categories[0]?.total ?? 0;
  const tools = pulse.tools?.rows.slice(0, 10) ?? [];

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

      <div className="boards" id="stats">
        <Board
          title="이번 주 가장 활발한 프로젝트"
          metric="active"
          pill="새 버전 수"
          foot={`새 버전을 낸 ${num(pulse.updates.projects)}개 중 상위 ${pulse.active.length} · 새 버전 = GitHub 릴리스·제작자 업데이트`}
          state={state}
        >
          {pulse.active.length === 0 ? (
            <div className="board-empty">최근 7일에 새 버전을 낸 프로젝트가 없습니다.</div>
          ) : (
            <ol className="board-list">
              {pulse.active.map((item, index) => (
                <li key={item.slug}>
                  <Link className="board-row" href={`/p/${item.slug}`}>
                    <span className="rank">{index + 1}</span>
                    <span className="board-name" title={item.name}>
                      {item.name}
                      <span className="board-meta">
                        {categoryLabel(item.category)}
                        {item.stars !== null && item.stars >= 100 ? ` · ★${num(item.stars)}` : ""}
                      </span>
                    </span>
                    <Bar value={item.releases} top={topActive} />
                    <b>{item.releases}건</b>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </Board>

        <Board
          title="분야 순위"
          metric="categories"
          pill={<>공개 수 · <span className="born">+</span> 이번 주 태어남</>}
          foot={`"기타" ${num(other)}개 제외 · 공개 ${num(pulse.total)}개 기준`}
          state={state}
        >
          {categories.length === 0 ? (
            <div className="board-empty">아직 공개된 프로젝트가 없습니다.</div>
          ) : (
            <ol className="board-list">
              {categories.map((item, index) => (
                <li key={item.key}>
                  <Link className="board-row" href={hrefWith(state, { category: item.key, sort: "recent" })}>
                    <span className="rank">{index + 1}</span>
                    <span className="board-name">
                      {categoryLabel(item.key)}
                      {item.born > 0 && <span className="born" title="이번 주 태어난 프로젝트">+{item.born}</span>}
                    </span>
                    <Bar value={item.total} top={topCategory} />
                    <b>{num(item.total)}</b>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </Board>

        {pulse.tools && (
          <Board
            title="제작 도구"
            metric="tools"
            pill="흔적을 찾은 프로젝트"
            foot={`저장소를 확인한 ${num(pulse.tools.scanned)}개 중 ${num(pulse.tools.withTool)}개 · 한 프로젝트에 여러 도구`}
            state={state}
          >
            {tools.length === 0 ? (
              <div className="board-empty">아직 도구 흔적을 찾은 프로젝트가 없습니다.</div>
            ) : (
              <ol className="board-list">
                {tools.map((tool, index) => (
                  <li key={tool.label}>
                    <span className="board-row">
                      <span className="rank">{index + 1}</span>
                      <span className="board-name">{tool.label}</span>
                      <Bar value={tool.count} top={tools[0].count} />
                      <b>{num(tool.count)}</b>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Board>
        )}
      </div>

      <div className="scope-note">
        <span>AI 업계 전체가 아닌, <b>nomorevibe 내부 활동</b></span>
      </div>
    </section>
  );
}
