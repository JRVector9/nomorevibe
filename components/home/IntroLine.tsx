import Link from "next/link";
import { metricHref, type BrowseState } from "@/components/home/browse-state";
import { formatAsOfKst, type HomePulse } from "@/lib/domain/products/home-pulse";

const num = (value: number) => value.toLocaleString("ko-KR");

/** 히어로 대신 한 줄 — 타이틀과 이번 주 숫자. 숫자를 누르면 집계 기준이 열린다 */
export function IntroLine({ pulse, state }: { pulse: HomePulse; state: BrowseState }) {
  return (
    <section className="intro-line" aria-label="소개">
      <h1 className="intro-title">AI로 만든 것들이 <em>제품</em>이 되는 곳.</h1>
      <p className="intro-stats">
        공개 <b>{num(pulse.total)}</b>
        {" · "}<Link href={metricHref(state, "born")}>이번 주 태어난 <b>{num(pulse.born.current)}</b></Link>
        {" · "}<Link href={metricHref(state, "updates")}>새 버전 낸 프로젝트 <b>{num(pulse.updates.projects)}</b></Link>
        {" · "}{formatAsOfKst(pulse.asOf).replace(" 기준", "")}
      </p>
    </section>
  );
}
