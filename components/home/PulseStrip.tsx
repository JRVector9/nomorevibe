import Link from "next/link";
import { formatAsOfKst, type HomePulse } from "@/lib/domain/products/home-pulse";

const num = (value: number) => value.toLocaleString("ko-KR");

/**
 * 메뉴 위 한 줄 — 이번 주 nomorevibe 안의 움직임.
 *
 * 태어난(저장소를 처음 만듦)과 새 버전을 낸(릴리스)을 이름으로 가른다. 항목을 누르면 그 숫자의
 * 집계 기준이 열린다. 좁은 화면에서는 줄 안에서만 옆으로 넘긴다.
 */
export function PulseStrip({ pulse, hrefFor }: { pulse: HomePulse; hrefFor: (metric: string) => string }) {
  const change = pulse.born.change;
  const tools = pulse.tools?.rows.slice(0, 3) ?? [];

  return (
    <section className="pulse-strip" aria-label="이번 주 nomorevibe">
      <div className="wrap pulse-strip-row">
        <span className="ps-label">이번 주</span>
        <Link className="ps-item" href={hrefFor("born")} title="저장소를 처음 만든 날이 최근 7일 안인 프로젝트">
          <span className="ps-key">태어난 프로젝트</span>
          <b>{num(pulse.born.current)}</b>
          {change !== null && (
            <em className={change < 0 ? "negative" : undefined} title="직전 7일 대비">
              {change < 0 ? "↘" : change > 0 ? "↗" : "±"}{Math.abs(change)}%
            </em>
          )}
        </Link>
        <span className="ps-sep" aria-hidden="true" />
        <Link className="ps-item" href={hrefFor("updates")} title="최근 7일 안에 새 버전을 낸 프로젝트">
          <span className="ps-key">새 버전을 낸 프로젝트</span>
          <b>{num(pulse.updates.projects)}</b>
          <span className="ps-sub">릴리스 {num(pulse.updates.releases)}건</span>
        </Link>
        {tools.length > 0 && (
          <>
            <span className="ps-sep" aria-hidden="true" />
            <Link className="ps-item" href={hrefFor("tools")} title="공개 프로젝트 저장소에서 흔적을 찾은 제작 도구">
              <span className="ps-key">가장 많이 쓰인 제작 도구</span>
              <b>{tools[0].label}</b>
              <span className="ps-sub">
                {[num(tools[0].count), ...tools.slice(1).map((tool) => `${tool.label} ${num(tool.count)}`)].join(" · ")}
              </span>
            </Link>
          </>
        )}
        <Link className="ps-info" href={hrefFor("all")} title={formatAsOfKst(pulse.asOf)}>집계 기준</Link>
      </div>
    </section>
  );
}
