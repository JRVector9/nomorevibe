"use client";

import { poolBaseText, poolCapsText, poolReserveText, type PoolHelpView } from "@/lib/operations/pool-help";
import { HelpTip } from "../../components/HelpTip";

/**
 * 「동시에」 도움말(ⓘ) — 작업 배정의 실행 방식 폼과 단계 패널의 모델 구역이 「동시에」 고르기 옆과 「칸 수」 옆에 둔다.
 * 내용은 buildPoolHelp(lib/operations/pool-help.ts)가 지금 고른 모델·칸 수와 읽은 한도로 만든 것 그대로다.
 */
export function PoolHelpTip({ view, label }: { view: PoolHelpView; label: string }) {
  return <HelpTip label={label}><PoolHelpContent view={view} /></HelpTip>;
}

export function PoolHelpContent({ view }: { view: PoolHelpView }) {
  return <div className="cs-help-body" data-pool-help={view.capsState}>
    <h4>「동시에」 — {view.taskLabel}</h4>
    <section aria-label="한 줄의 뜻">
      <p>한 줄은 「이 모델에도 일을 나눈다」는 뜻입니다. 같은 모델을 두 줄 넣어도 동시에 두 배로 부르지 않습니다 — 고를 차례만 두 배가 되고 그 모델이 동시에 받는 수는
        그대로입니다(같은 모델 두 줄은 함께 쉽니다).{view.caps ? " 한 모델을 동시에 N개 쓰려면 한 줄만 넣고 「칸 수」에 N을 적습니다." : ""}</p>
      {view.example && <p className="cs-help-em">{view.example}</p>}
    </section>
    {view.caps ? <section aria-label="칸 수와 동시 처리 수">
      <p>{poolBaseText(view)}</p>
      <p>{poolCapsText(view)}</p>
      {view.capsState === "partial" && <p className="cs-help-warn" role="note">지금 일부 줄에만 칸 수가 있어 저장되지 않습니다 — 모두 적거나 모두 비우세요.</p>}
    </section> : <section aria-label="칸 수">
      <p>이 작업은 아직 모델별 칸 수·예비를 따르지 않습니다. 일 하나마다 묶은 모델 하나를 고르고, 동시 처리 수는 모델마다 동시에 받는 수가 정합니다.</p>
    </section>}
    {view.caps && <section aria-label="권장 설정">
      <p className="cs-help-lab">권장 설정 — 지금 고른 모델{view.devicesRead ? "" : " · 한도를 읽지 못함"}</p>
      {/* 모델 이름 하나만 — 어느 서버·칸인지는 적지 않는다(소유자 「모델 사용량만 보면 돼」) */}
      {view.rows.length ? <div className="cs-help-scroll"><table className="cs-help-table">
        <colgroup><col style={{ width: 44 }} /><col style={{ width: "34%" }} /><col style={{ width: 56 }} /><col /></colgroup>
        <thead><tr><th scope="col" className="n">순서</th><th scope="col">모델</th><th scope="col" className="n">칸 수</th><th scope="col">근거</th></tr></thead>
        <tbody>{view.rows.map(row => <tr key={row.index} data-bound={row.bound}>
          <td className="n">{row.order}</td>
          <th scope="row">{row.name}{row.twinOf !== null && <span className="cs-help-warn"> · {row.twinOf}번과 같은 모델</span>}</th>
          <td className="n">{row.recommended ?? "—"}</td>
          <td className="q">{row.reason}</td>
        </tr>)}</tbody>
      </table></div> : <p className="cs-help-q">아직 고른 모델이 없습니다 — 모델을 고르면 모델마다 권할 칸 수가 여기에 나옵니다.</p>}
      {view.shared.map(note => <p key={note}>{note}</p>)}
      <p className="cs-help-q">권장 칸 수 = 그 모델이 동시에 받을 수 있는 수입니다. 같은 모델을 다른 단계도 쓰면 바쁠 때 이보다 적게 받을 수 있습니다.</p>
    </section>}
    {view.reserve && <p>{poolReserveText(view)}</p>}
  </div>;
}

/** 줄 옆 경고 — 도움말을 열지 않아도 보인다(같은 모델 두 줄 · 모델이 동시에 받는 수 넘김) */
export function PoolMemberWarnings({ warnings }: { warnings: readonly string[] }) {
  if (!warnings.length) return null;
  return <span className="cs-pool-warn" role="note">{warnings.join(" · ")}</span>;
}
