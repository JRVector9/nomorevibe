"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/components/home/icons";
import { categoryLabel } from "@/lib/domain/products/labels";
import type { HomePulseView } from "@/components/home/types";

function Formula({ children }: { children: React.ReactNode }) {
  return <code className="formula">{children}</code>;
}

export function MethodologyDialog({ pulse }: { pulse: HomePulseView }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const skipClose = useRef(false);
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const metric = params.get("metric") ?? "";
  const open = pathname === "/" && ["all", "launches", "tools", "interest", "updates"].includes(metric);

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

  function closeHref() {
    const next = new URLSearchParams(params.toString());
    next.delete("metric");
    const qs = next.toString();
    return qs ? `/?${qs}` : "/";
  }

  function close() {
    router.replace(closeHref(), { scroll: false });
  }

  const nav = (
    <div className="metric-links">
      {([["launches", "출시 수"], ["tools", "제작 도구"], ["interest", "관심 분야"], ["updates", "업데이트"]] as const).map(([key, label]) => (
        <button
          type="button"
          key={key}
          onClick={() => {
            const next = new URLSearchParams(params.toString());
            next.set("metric", key);
            router.replace(`/?${next.toString()}`, { scroll: false });
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );

  const blocks: Record<string, React.ReactNode> = {
    launches: (
      <>
        <h3>점수가 아니라 개수입니다.</h3>
        <p>
          최근 끝난 7일 동안 <b>처음 공개된 승인·공개 프로젝트의 고유 개수</b>입니다.
          같은 프로젝트의 업데이트는 새로운 출시로 세지 않습니다.
        </p>
        <Formula>
          출시 수 = COUNT(DISTINCT project)
          <br />
          증감률 = (이번 7일 − 직전 7일) ÷ 직전 7일 × 100
        </Formula>
        <table className="method-table">
          <tbody>
            <tr><td>최근 7일</td><td>{pulse.launches.current}개</td></tr>
            <tr><td>직전 7일</td><td>{pulse.launches.previous}개</td></tr>
            <tr><td>증감률</td><td>{pulse.launches.change === null ? "표본 부족 (직전 20개 미만)" : `${pulse.launches.change}%`}</td></tr>
          </tbody>
        </table>
        <p>확인할 수 없을 때 0%를 채우지 않습니다. 출시가 없으면 건수는 0개입니다.</p>
      </>
    ),
    tools: (
      <>
        <h3>이곳의 메이커는 무엇으로 만들었을까?</h3>
        <p>최근 끝난 30일에 처음 공개한 프로젝트 중 제작 도구가 등록된 프로젝트가 분모입니다.</p>
        <Formula>도구 비중 = 해당 도구 등록 프로젝트 수 ÷ 도구 응답 프로젝트 수 × 100</Formula>
        <table className="method-table">
          <thead><tr><th>도구</th><th>프로젝트 수</th><th>응답 기준 비중</th></tr></thead>
          <tbody>
            {pulse.tools.rows.map((row) => (
              <tr key={row.name}>
                <td>{row.name}</td>
                <td>{row.count}개</td>
                <td>{row.percent === null ? "—" : `${row.percent}%`}</td>
              </tr>
            ))}
            <tr><td>응답 범위</td><td colSpan={2}>최근 30일 {pulse.tools.total}개 중 {pulse.tools.reported}개 응답</td></tr>
          </tbody>
        </table>
        <p>여러 도구를 쓸 수 있어 합은 100%를 넘을 수 있습니다. 제작자 신고이며 실제 생성 코드 비율이나 전 세계 점유율이 아닙니다. 응답 20개 미만이면 비율 대신 건수만 표시합니다.</p>
      </>
    ),
    interest: (
      <>
        <h3>인기 점수 대신, 제품별 고유 방문의 변화.</h3>
        <p>
          제품마다 같은 브라우저의 중복을 제거한 <code>/go</code> 방문 수를 분야별로 합산합니다.
          같은 브라우저가 같은 제품을 다시 봐도 기간별 1건이고, 다른 제품을 보면 각각 집계됩니다.
        </p>
        <Formula>관심 증감률 = (최근 7일 제품별 고유 방문 − 직전 7일 제품별 고유 방문) ÷ 직전 7일 제품별 고유 방문 × 100</Formula>
        <table className="method-table">
          <thead><tr><th>분야</th><th>직전 7일</th><th>최근 7일</th><th>변화</th></tr></thead>
          <tbody>
            {pulse.categories.map((item) => (
              <tr key={item.key}>
                <td>{categoryLabel(item.key)}</td>
                <td>{item.previous}건</td>
                <td>{item.current}건</td>
                <td>{item.change === null ? (pulse.interestReady ? "표본 부족" : "수집 기간 미완료") : `${item.change >= 0 ? "+" : ""}${item.change}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>수집 시작 뒤 두 비교 기간이 모두 끝나기 전이거나 직전 기간 제품별 고유 방문이 100건 미만이면 증감률을 숨깁니다. 봇·해시 없는 방문은 제외합니다. 관심은 매출이나 만족도가 아닙니다.</p>
      </>
    ),
    updates: (
      <>
        <h3>한번 출시하고 끝난 프로젝트가 아닌가?</h3>
        <p>
          최근 끝난 7일 동안 공개된 릴리스가 있는 <b>고유 프로젝트 수</b>입니다.
          릴리스 {pulse.updates.releases}건이어도 같은 프로젝트를 합치면 {pulse.updates.projects}개입니다.
        </p>
        <Formula>
          업데이트 프로젝트 수 = COUNT(DISTINCT slug)
          <br />
          릴리스 건수 = COUNT(공개 github_release·maker 업데이트)
        </Formula>
        <p>소개문 수정이나 자동 재배포는 넣지 않습니다. 코드 품질이나 가동률을 보증하지 않습니다.</p>
      </>
    ),
  };

  const body = metric === "all" || !blocks[metric]
    ? (
      <>
        <h3>출처, 기간, 분모가 보이는 숫자.</h3>
        <p>상단 지표는 전체 nomorevibe 기준입니다. 아래 제품 목록의 검색·필터를 바꿔도 지표 집계 범위는 바뀌지 않습니다. 비교는 끝난 7일끼리, 제작 도구는 끝난 30일을 사용합니다.</p>
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
        <Link href={closeHref()} className="close-btn" aria-label="닫기" scroll={false}>
          <Icon name="close" />
        </Link>
      </div>
      <div className="modal-body">
        <div className="notice">
          AI 업계 전체의 시장 점유율·심리·사용량을 뜻하지 않습니다. 확인된 0과 계산할 수 없는 비율을 구별합니다.
        </div>
        {body}
        <p className="method-foot">방법론 v{pulse.methodVersion} · {pulse.asOfLabel} · 기간은 시작 포함, 끝 제외</p>
      </div>
    </dialog>
  );
}
