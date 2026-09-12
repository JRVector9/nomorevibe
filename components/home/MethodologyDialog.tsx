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
  const open = pathname === "/" && ["all", "born", "updates", "active", "categories", "tools", "popular"].includes(metric);

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

  const metrics: [string, string][] = [["popular", "스타 구간"], ["born", "태어난 프로젝트"], ["updates", "새 버전"], ["active", "활발한 프로젝트"], ["categories", "분야 순위"]];
  if (pulse.tools) metrics.push(["tools", "제작 도구"]);
  const nav = (
    <div className="metric-links">
      {metrics.map(([key, label]) => (
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
    popular: (<>
      <h3>많이 쓰이는 프로젝트 — GitHub 스타 구간.</h3>
      <p>공개된 제품을 스타 2천–5천 미만, 5천–1만 미만, 1만–3만 미만, 3만–10만 미만으로 나눕니다. 각 구간은 스타 많은 순이고, 같으면 등재 ID 순입니다. 홈에는 구간별 10개, 전체 목록에는 페이지당 15개를 보여줍니다.</p>
      <p>스타는 저장소에 남긴 관심 표시로, 실제 이용자 수나 제품 품질을 보증하지 않습니다. 개인 계정만 필터는 GitHub의 User 유형만 포함합니다. 조직과 미확인 계정은 포함하지 않습니다.</p>
      <p>스타는 저장된 GitHub 원본에서 시작해 하루 간격으로 다시 확인합니다. 실패하면 마지막 성공 값과 확인일을 유지하며, 작업 대기로 더 늦어질 수 있습니다. 미공개·차단·접속 불가 제품과 스타 10만 이상은 제외합니다. 제작 근거는 각 제품 상세에서 확인할 수 있습니다.</p>
    </>),
    born: (
      <>
        <h3>태어난 프로젝트 — 저장소를 처음 만든 날로 셉니다.</h3>
        <p>
          공개 프로젝트 중 <b>GitHub 저장소를 처음 만든 날</b>이 최근 끝난 7일 안인 것의 개수입니다.
          우리 목록에 오른 날(소개된 날)도, 새 버전을 낸 날도 아닙니다.
        </p>
        <Formula>
          태어난 프로젝트 = COUNT(저장소 created_at ∈ 최근 7일)
          <br />
          증감률 = (이번 7일 − 직전 7일) ÷ 직전 7일 × 100
        </Formula>
        <table className="method-table">
          <tbody>
            <tr><td>최근 7일</td><td>{pulse.born.current}개</td></tr>
            <tr><td>직전 7일</td><td>{pulse.born.previous}개</td></tr>
            <tr><td>증감률</td><td>{pulse.born.change === null ? "표본 부족 (직전 20개 미만)" : `${pulse.born.change}%`}</td></tr>
          </tbody>
        </table>
        <p>찾고 심사하는 데 시간이 걸려, 최근 며칠에 태어난 프로젝트는 뒤늦게 더해질 수 있습니다. 확인할 수 없을 때 0%를 채우지 않습니다.</p>
      </>
    ),
    updates: (
      <>
        <h3>새 버전을 낸 프로젝트 — 출시 뒤에도 계속 만드는가.</h3>
        <p>
          최근 끝난 7일 동안 공개된 릴리스가 있는 <b>고유 프로젝트 수</b>입니다.
          릴리스 {pulse.updates.releases}건이어도 같은 프로젝트를 합치면 {pulse.updates.projects}개입니다.
        </p>
        <Formula>
          새 버전을 낸 프로젝트 = COUNT(DISTINCT slug)
          <br />
          릴리스 건수 = COUNT(공개 github_release·maker 업데이트)
        </Formula>
        <p>소개문 수정이나 자동 재배포는 넣지 않습니다. 코드 품질이나 가동률을 보증하지 않습니다.</p>
      </>
    ),
    active: (
      <>
        <h3>가장 활발한 프로젝트 — 새 버전을 낸 횟수.</h3>
        <p>최근 끝난 7일 동안 새 버전(GitHub 릴리스·제작자 업데이트)을 가장 많이 낸 공개 프로젝트 순입니다. 같으면 이름 순입니다.</p>
        <Formula>활발함 = COUNT(최근 7일 공개 릴리스) · 상위 {pulse.active.length}개</Formula>
        <p>릴리스를 잘게 나눠 내는 프로젝트가 앞에 설 수 있습니다. 좋고 나쁨이 아니라 움직임의 크기입니다.</p>
      </>
    ),
    categories: (
      <>
        <h3>분야 순위 — 공개 수와 이번 주 태어난 수.</h3>
        <p>분야마다 지금 공개된 프로젝트 수이고, 옆의 <b>+숫자</b>는 그중 저장소를 최근 7일 안에 처음 만든 것입니다. 어디에도 맞지 않는 &ldquo;기타&rdquo;는 순위에서 뺍니다.</p>
        <table className="method-table">
          <thead><tr><th>분야</th><th>공개</th><th>이번 주 태어남</th></tr></thead>
          <tbody>
            {pulse.categories.map((item) => (
              <tr key={item.key}>
                <td>{categoryLabel(item.key)}</td>
                <td>{item.total}개</td>
                <td>{item.born}개</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    ),
    ...(pulse.tools ? {
      tools: (
        <>
          <h3>제작 도구 — 저장소에 남은 흔적으로 셉니다.</h3>
          <p>
            공개 프로젝트의 저장소에서 커밋 기여 표기, 도구 설정 파일, 에이전트 지침 파일 같은 <b>흔적을 찾은 프로젝트 수</b>입니다.
            제작자 신고가 아니고, 실제 생성 코드 비율이나 전 세계 점유율도 아닙니다.
          </p>
          <Formula>도구별 프로젝트 수 = COUNT(DISTINCT 흔적을 찾은 공개 프로젝트)</Formula>
          <table className="method-table">
            <thead><tr><th>도구</th><th>프로젝트 수</th></tr></thead>
            <tbody>
              {pulse.tools.rows.map((row) => (
                <tr key={row.label}><td>{row.label}</td><td>{row.count}개</td></tr>
              ))}
              <tr><td>확인 범위</td><td>저장소를 확인한 {pulse.tools.scanned}개 중 {pulse.tools.withTool}개에서 흔적</td></tr>
            </tbody>
          </table>
          <p>한 프로젝트가 여러 도구를 쓸 수 있어 합은 흔적을 찾은 프로젝트 수보다 클 수 있습니다. 지침 파일은 다른 도구도 읽을 수 있어 사용을 증명하지 않습니다.</p>
        </>
      ),
    } : {}),
  };

  const body = metric === "all" || !blocks[metric]
    ? (
      <>
        <h3>출처, 기간, 분모가 보이는 숫자.</h3>
        <p>윗줄과 순위는 전체 nomorevibe 기준입니다. 아래 제품 목록의 검색·필터를 바꿔도 집계 범위는 바뀌지 않습니다. &ldquo;이번 주&rdquo;는 끝난 7일이고, 이름의 동사로 가릅니다 — 태어났다(저장소를 처음 만듦) · 새 버전을 냈다(릴리스).</p>
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
