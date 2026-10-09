"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/components/home/icons";
import { NEW_PROJECTS_LABEL } from "@/lib/copy/terms";
import { formatCount } from "@/lib/format/number";
import { categoryLabel } from "@/lib/domain/products/labels";
import { hiddenByDefault } from "@/lib/domain/products/visibility";
import type { HomePulseView } from "@/components/home/types";

/**
 * 계산식·세부 조건은 '자세히' 안에 접는다(UX-37) — 본문은 지표마다 쉬운 문장 하나로 읽힌다.
 * 식을 궁금해하는 사람만 펼친다.
 */
function Details({ children }: { children: React.ReactNode }) {
  return (
    <details className="method-more">
      <summary>자세히</summary>
      {children}
    </details>
  );
}

function Formula({ children }: { children: React.ReactNode }) {
  return <code className="formula">{children}</code>;
}

/** 대화창이 열리는 화면 — 홈과 분야 화면(/c/…)이 같은 목록을 쓴다 */
const isBrowsePath = (pathname: string) => pathname === "/" || pathname.startsWith("/c/");

export function MethodologyDialog({ pulse, rankingFallback = false }: {
  pulse: HomePulseView;
  /** 검증 제품이 모자라 순위 탭이 스타 목록을 대신 보여주는 동안(app/page.tsx fallbackSort) 그 기준도 적는다 */
  rankingFallback?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const skipClose = useRef(false);
  const params = useSearchParams();
  const pathname = usePathname();
  const metric = params.get("metric") ?? "";
  const open = isBrowsePath(pathname) && ["all", "born", "updates", "active", "categories", "tools", "popular", "rising"].includes(metric);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (!open) {
      if (node.open) node.close();
      return;
    }
    try {
      if (!node.open) node.showModal();
    } catch {
      skipClose.current = true;
      node.close();
      node.showModal();
    }
  }, [open]);

  function hrefWithMetric(metricKey: string | null) {
    const next = new URLSearchParams(params.toString());
    if (metricKey) next.set("metric", metricKey);
    else next.delete("metric");
    const qs = next.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  /*
   * 대화창은 주소의 metric 을 브라우저에서만 읽는다(서버 렌더는 쓰지 않는다). router.replace 는 홈 전체를 서버가 다시
   * 그리게 해 탭을 누를 때마다 쿼리 26개가 돌았다(2026-10-06) — 주소만 바꾼다. useSearchParams 가 따라 바뀐다.
   */
  function close() {
    window.history.replaceState(null, "", hrefWithMetric(null));
  }

  const metrics: [string, string][] = [["popular", "스타 구간"], ["born", NEW_PROJECTS_LABEL], ["updates", "새 버전"], ["active", "활발한 프로젝트"], ["categories", "분야 순위"]];
  if (pulse.tools) metrics.push(["tools", "제작 도구"]);
  if (rankingFallback) metrics.push(["rising", "지금 뜨는"]);
  const nav = (
    <div className="metric-links">
      {metrics.map(([key, label]) => (
        <button
          type="button"
          key={key}
          onClick={() => window.history.replaceState(null, "", hrefWithMetric(key))}
        >
          {label}
        </button>
      ))}
    </div>
  );

  // 기본 목록에서 빼는 분야(개인 프로필, 계약 C3)는 분야 순위에도 싣지 않는다
  const categories = pulse.categories.filter((item) => !hiddenByDefault(item.key));

  const blocks: Record<string, React.ReactNode> = {
    popular: (<>
      <h3>많이 쓰이는 프로젝트 — GitHub 스타 구간.</h3>
      <p>공개된 프로젝트를 GitHub 스타 수로 2천+ · 5천+ · 1만+ · 3만+ 네 구간으로 나눠, 구간마다 스타가 많은 순으로 보여 줍니다.</p>
      <Details>
        <p>각 구간은 다음 구간의 시작 바로 아래까지이고(3만+는 10만 미만), 스타가 같으면 등재 ID 순입니다. 홈에는 구간별 상위 3개, 전체 목록에는 페이지당 15개를 보여줍니다.</p>
        <p>스타는 저장소에 남긴 관심 표시로, 실제 이용자 수나 품질을 보증하지 않습니다. 개인 계정만 필터는 GitHub의 User 유형만 포함합니다. 조직과 미확인 계정은 포함하지 않습니다.</p>
        <p>스타는 저장된 GitHub 원본에서 시작해 프로젝트마다 하루가 지난 뒤 차례로 다시 확인합니다(지금은 보통 2~3일 간격). 실패하면 마지막 성공 값과 확인일을 유지하며, 작업 대기로 더 늦어질 수 있습니다. 미공개·차단·접속 불가 프로젝트와 스타 10만 이상은 제외합니다. 제작 근거는 각 프로젝트 상세에서 확인할 수 있습니다.</p>
      </Details>
    </>),
    born: (
      <>
        <h3>{NEW_PROJECTS_LABEL} — 저장소를 처음 만든 날로 셉니다.</h3>
        <p>지난 7일 동안 GitHub에 새로 만들어진 저장소 수입니다.</p>
        <table className="method-table">
          <tbody>
            <tr><td>최근 7일</td><td>{formatCount(pulse.born.current)}개</td></tr>
            <tr><td>직전 7일</td><td>{formatCount(pulse.born.previous)}개</td></tr>
            <tr><td>증감률</td><td>{pulse.born.change === null ? "표본 부족 (직전 20개 미만)" : `${pulse.born.change}%`}</td></tr>
          </tbody>
        </table>
        <Details>
          <p>공개 프로젝트 중 <b>GitHub 저장소를 처음 만든 날</b>이 최근 끝난 7일 안인 것을 셉니다. 우리 목록에 오른 날도, 새 버전을 낸 날도 아닙니다.</p>
          <Formula>
            {NEW_PROJECTS_LABEL} = 저장소를 만든 때가 최근 7일 안인 공개 프로젝트 수
            <br />
            증감률 = (이번 7일 − 직전 7일) ÷ 직전 7일 × 100
          </Formula>
          <p>찾고 심사하는 데 시간이 걸려, 최근 며칠에 생긴 프로젝트는 뒤늦게 더해질 수 있습니다. 확인할 수 없을 때 0%를 채우지 않습니다.</p>
        </Details>
      </>
    ),
    updates: (
      <>
        <h3>새 버전을 낸 프로젝트 — 출시 뒤에도 계속 만드는가.</h3>
        <p>지난 7일 동안 새 버전(GitHub 릴리스·제작자 업데이트)을 낸 프로젝트 수입니다.</p>
        <Details>
          <p>
            같은 프로젝트가 여러 번 내도 한 번만 셉니다 — 릴리스 {formatCount(pulse.updates.releases)}건을 프로젝트로 합치면 {formatCount(pulse.updates.projects)}개입니다.
          </p>
          <Formula>
            새 버전을 낸 프로젝트 = 최근 7일에 공개 릴리스가 있는 서로 다른 프로젝트 수
            <br />
            릴리스 건수 = 최근 7일의 공개 GitHub 릴리스·제작자 업데이트 수
          </Formula>
          <p>소개문 수정이나 자동 재배포는 넣지 않습니다. 코드 품질이나 가동률을 보증하지 않습니다.</p>
        </Details>
      </>
    ),
    active: (
      <>
        <h3>가장 활발한 프로젝트 — 새 버전을 낸 횟수.</h3>
        <p>지난 7일 동안 새 버전을 가장 많이 낸 프로젝트 순입니다.</p>
        <Details>
          <p>새 버전은 GitHub 릴리스와 제작자 업데이트입니다. 횟수가 같으면 이름 순입니다.</p>
          <Formula>활발함 = 최근 7일 공개 릴리스 수 · 상위 {formatCount(pulse.active.length)}개</Formula>
          <p>릴리스를 잘게 나눠 내는 프로젝트가 앞에 설 수 있습니다. 좋고 나쁨이 아니라 움직임의 크기입니다.</p>
        </Details>
      </>
    ),
    categories: (
      <>
        <h3>분야 순위 — 공개 수와 {NEW_PROJECTS_LABEL} 수.</h3>
        <p>분야마다 공개된 프로젝트 수와, 그중 지난 7일 동안 저장소가 새로 만들어진 수입니다.</p>
        <table className="method-table">
          <thead><tr><th>분야</th><th>공개</th><th>이번 주 새로 생김</th></tr></thead>
          <tbody>
            {categories.map((item) => (
              <tr key={item.key}>
                <td>{categoryLabel(item.key)}</td>
                <td>{formatCount(item.total)}개</td>
                <td>{formatCount(item.born)}개</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Details>
          <p>어디에도 맞지 않는 &ldquo;기타&rdquo;는 순위에서 뺍니다. 개인 프로필은 본인이 등록하거나 확인한 것만 보이므로 분야 순위에 싣지 않습니다.</p>
        </Details>
      </>
    ),
    ...(rankingFallback ? {
      rising: (
        <>
          <h3>지금 뜨는 — 최근 GitHub 스타가 하루 평균 가장 많이 는 순.</h3>
          <p>최근 두 번 확인한 사이에 GitHub 스타가 하루 평균 가장 많이 늘어난 프로젝트 순입니다.</p>
          <Details>
            <p>
              순위는 검증된 프로젝트의 유효 방문으로 매기는데, 검증된 프로젝트가 아직 모자랍니다. 그동안 &ldquo;지금 뜨는&rdquo;은 공개 프로젝트를
              <b> 마지막 두 번 확인한 사이에 하루 평균 늘어난 스타</b> 순으로 보여줍니다 — 늘어난 것만, 스타 2천 미만만입니다(그 위는 스타 구간이
              따로 보여줍니다). 마지막 확인이 운영자가 정한 기간(기본 7일)보다 오래된 프로젝트(저장소가 사라졌거나 확인이 계속 실패한 것)는 뺍니다.
              &ldquo;관심 많은 순&rdquo;은 같은 동안 스타 많은 순입니다.
            </p>
            <Formula>하루 평균 증가 = (이번 확인 스타 − 직전 확인 스타) ÷ 두 확인 사이 일수(1일 미만은 1일) · 확인 간격은 지금 보통 2~3일</Formula>
            <p>
              각 카드의 ★ 옆 숫자는 두 확인 사이에 는 전체이고, 확인한 두 시각은 그 숫자에 올리면 보입니다. 간격이 프로젝트마다 달라 순서는
              그 숫자를 일수로 나눈 값으로 정합니다 — 숫자가 작은 카드가 앞에 설 수 있습니다. 검증된 프로젝트가 모이면 방문 순위로 돌아갑니다.
            </p>
          </Details>
        </>
      ),
    } : {}),
    ...(pulse.tools ? {
      tools: (
        <>
          <h3>제작 도구 — 저장소에 남은 흔적으로 셉니다.</h3>
          <p>공개 프로젝트의 저장소에서 AI 코딩 도구의 흔적을 찾은 프로젝트 수입니다.</p>
          <table className="method-table">
            <thead><tr><th>도구</th><th>프로젝트 수</th></tr></thead>
            <tbody>
              {pulse.tools.rows.map((row) => (
                <tr key={row.label}><td>{row.label}</td><td>{formatCount(row.count)}개</td></tr>
              ))}
              <tr><td>확인 범위</td><td>저장소를 확인한 {formatCount(pulse.tools.scanned)}개 중 {formatCount(pulse.tools.withTool)}개에서 흔적</td></tr>
            </tbody>
          </table>
          <Details>
            <p>
              흔적은 커밋 기여 표기, 도구 설정 파일, 에이전트 지침 파일 같은 것입니다. 제작자 신고가 아니고, 실제 생성 코드 비율이나 전 세계 점유율도 아닙니다.
            </p>
            <Formula>도구별 프로젝트 수 = 그 도구의 흔적을 찾은 서로 다른 공개 프로젝트 수</Formula>
            <p>한 프로젝트가 여러 도구를 쓸 수 있어 합은 흔적을 찾은 프로젝트 수보다 클 수 있습니다. 지침 파일은 다른 도구도 읽을 수 있어 사용을 증명하지 않습니다.</p>
          </Details>
        </>
      ),
    } : {}),
  };

  const body = metric === "all" || !blocks[metric]
    ? (
      <>
        <h3>출처, 기간, 분모가 보이는 숫자.</h3>
        <p>윗줄과 순위는 전체 nomorevibe 기준입니다. 아래 목록의 검색·필터를 바꿔도 집계 범위는 바뀌지 않습니다. &ldquo;이번 주&rdquo;는 어제 자정에 끝난 7일입니다.</p>
        {nav}
        {Object.values(blocks).map((block, index) => (
          <div key={index}>
            {index > 0 && <hr className="method-rule" />}
            {block}
          </div>
        ))}
      </>
    )
    : <>{nav}{blocks[metric]}</>;

  return (
    <dialog
      ref={dialog}
      id="dialog"
      aria-labelledby="dialog-title"
      data-metric={metric || undefined}
      onClose={() => {
        if (skipClose.current) {
          skipClose.current = false;
          return;
        }
        close();
      }}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) close();
      }}
    >
      <div className="modal-head">
        <h2 id="dialog-title">숫자의 기준</h2>
        <Link prefetch={false} href={hrefWithMetric(null)} className="close-btn" aria-label="닫기" scroll={false}>
          <Icon name="close" />
        </Link>
      </div>
      <div className="modal-body">
        <div className="notice">
          AI 업계 전체의 시장 점유율·심리·사용량을 뜻하지 않습니다. 확인된 0과 계산할 수 없는 비율을 구별합니다.
        </div>
        {body}
        <p className="method-foot">{pulse.asOfLabel} 기준 · 기간은 시작 포함, 끝 제외 · 집계 방식 v{pulse.methodVersion}</p>
      </div>
    </dialog>
  );
}
