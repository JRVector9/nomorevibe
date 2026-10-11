import Link from "next/link";
import { metricHref, type BrowseState } from "@/components/home/browse-state";
import { NEW_THIS_WEEK_LABEL } from "@/lib/copy/terms";
import { formatCount } from "@/lib/format/number";
import type { HomePulse } from "@/lib/domain/products/home-pulse";

/**
 * 히어로 대신 한 줄 — 타이틀과 숫자. 숫자를 누르면 집계 기준이 열린다.
 *
 * '공개'는 아래 목록의 '공개 n개'와 같은 값(지금 세는 공개 수)을 받는다 — 같은 화면에 공개 수가 둘이면 안 된다(UX-27).
 * 이번 주 두 수는 어제 자정에 닫힌 7일로 센다 — 그 기준을 줄 끝에 밝힌다(날짜와 KST 는 집계 기준 창에서).
 *
 * 타이틀 아래 부제 한 줄 — 무엇을 어디서 모았고 표시가 무엇을 뜻하는지(UX-06). 약속은 실제와 맞춘다: 목록은 공개 저장소에서
 * 찾아 모은 것이고, 'AI'는 저장소에 남은 AI 코딩 도구 흔적에서, ✓는 메이커가 도메인 소유권을 확인한 곳에만 붙는다.
 * 자세한 수집·근거·내려달라는 요청은 게재 기준(/policy)이 맡는다.
 */
export function IntroLine({ pulse, total, state }: { pulse: HomePulse; total: number; state: BrowseState }) {
  return (
    <section className="intro-line" aria-label="소개">
      <div className="intro-head">
        <h1 className="intro-title">AI로 만든 것들이 <em>제품</em>이 되는 곳.</h1>
        <p className="intro-sub">
          공개 저장소에서 찾아 모은 프로젝트입니다. ‘AI’는 저장소에 남은 AI 코딩 도구 흔적으로, ✓는 메이커가 도메인을 확인한 곳에만 붙습니다.{" "}
          <Link prefetch={false} href="/policy#listing">어떻게 고르나요</Link>
        </p>
      </div>
      <p className="intro-stats">
        공개 <b>{formatCount(total)}</b>
        {" · "}<Link prefetch={false} href={metricHref(state, "born")}>{NEW_THIS_WEEK_LABEL} <b>{formatCount(pulse.born.current)}</b></Link>
        {" · "}<Link prefetch={false} href={metricHref(state, "updates")}>새 버전 낸 프로젝트 <b>{formatCount(pulse.updates.projects)}</b></Link>
        {" · "}이번 주 = 어제 자정까지 7일
      </p>
    </section>
  );
}
