import Link from "next/link";
import { metricHref, type BrowseState } from "@/components/home/browse-state";
import type { HomePulse } from "@/lib/domain/products/home-pulse";

const num = (value: number) => value.toLocaleString("ko-KR");

/**
 * 무엇으로 만들었나 — 공개 프로젝트 저장소에서 찾은 AI 코딩 도구 흔적.
 *
 * 알약은 지금 걸러 보기로 이어지지 않는다 — `?builder=` 는 메이커가 신고한 값(3%)만 거르고 흔적은 다른 표다.
 * 흔적으로 거르는 조회가 생기기 전까지 집계 기준 창을 연다.
 */
export function ToolsBoard({ tools, state }: { tools: HomePulse["tools"]; state: BrowseState }) {
  if (!tools || tools.rows.length === 0) return null;
  return (
    <section className="tools-board" aria-labelledby="tools-title">
      <div className="row-head">
        <div>
          <h2 id="tools-title" className="row-title">무엇으로 만들었나</h2>
          <p className="row-note">공개 프로젝트의 저장소에서 찾은 AI 코딩 도구 흔적 · 확인한 {num(tools.scanned)}개 중 {num(tools.withTool)}개 · 한 저장소에 여러 도구</p>
        </div>
      </div>
      <ul className="chips">
        {tools.rows.slice(0, 8).map((tool, index) => (
          <li key={tool.label}>
            <Link href={metricHref(state, "tools")} className={`chip${index === 0 ? " chip-dark" : ""}`}>
              {tool.label} <span className="chip-count">{num(tool.count)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="row-foot">흔적은 설정 파일·커밋 서명에서 자동으로 찾습니다. 메이커가 신고한 값은 상세에서 따로 표시합니다.</p>
    </section>
  );
}
