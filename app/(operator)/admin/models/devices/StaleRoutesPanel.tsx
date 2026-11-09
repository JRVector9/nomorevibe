"use client";

import { useActionState, useState } from "react";
// 형만 가져온다 — 화면 모형 모듈은 서버에서 만든다
import type { StaleRouteItem } from "@/lib/operations/admin-capacity-device-table-view";
import { pruneStaleCapacityRoutesAction, type DeviceSaveState } from "./actions";

/**
 * 「옛 정책 경로 정리」(2026-11-09) — 정책에 남았지만 아무도 부르지 않는 route 후보(readAdminStaleCapacityRoutes)를 골라 뺀다.
 * 두 단계: 고르고 「선택한 N개 정리」 → 「정말 정리」/취소. 서버 action 은 confirm=yes·후보를 본 정책 판(expectedRevision)·route JSON 을 받고,
 * 고른 route 가 지금도 모두 후보여야 뺀다(아니면 아무것도 빼지 않고 이유를 돌려준다). 후보가 없으면(그리고 보일 결과도 없으면) 패널을 그리지 않는다.
 */
export function StaleRoutesPanel({ items, revision, readOnly, error }: { items: readonly StaleRouteItem[]; revision: number | null; readOnly: boolean; error: string | null }) {
  const [state, action, pending] = useActionState<DeviceSaveState, FormData>(pruneStaleCapacityRoutesAction, null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [asking, setAsking] = useState(false);
  // 결과가 오면 확인 칸을 닫고, 정리했으면 고른 것을 비운다(제출 클릭 안에서는 단추를 지우지 않는다 — 지우면 제출이 나가지 않는다)
  const [seen, setSeen] = useState(state);
  if (seen !== state) { setSeen(state); setAsking(false); if (state?.ok) setPicked(new Set()); }
  const live = new Set(items.map(item => item.value));
  const chosen = [...picked].filter(value => live.has(value));
  if (error) return <p role="note" className="devlim-note">옛 정책 경로 후보를 읽지 못했습니다({error}).</p>;
  if (!items.length && !state) return null;
  const toggle = (value: string, on: boolean) => setPicked(previous => { const next = new Set(previous); if (on) next.add(value); else next.delete(value); return next; });
  return <section className="devlim-panel" aria-labelledby="devlim-stale-title" data-dirty={chosen.length || asking ? "" : undefined}>
    <div className="devlim-panel-head">
      <h2 id="devlim-stale-title">옛 정책 경로 정리</h2>
      <span className="devlim-muted">아무도 부르지 않는 정책 경로 {items.length}개</span>
    </div>
    {items.length > 0 && <form action={action} className="devlim-panel-body">
      <input type="hidden" name="confirm" value="yes" />
      <input type="hidden" name="expectedRevision" value={revision ?? ""} />
      <div className="devlim-scroll">
        <table className="devlim-table devlim-stale-table">
          <caption className="admin-vh">정리 후보 — 경로 · 모델 · 서버 · 까닭</caption>
          <thead><tr><th scope="col"><span className="admin-vh">고르기</span></th><th scope="col">경로</th><th scope="col">모델</th><th scope="col">서버</th><th scope="col">까닭</th></tr></thead>
          <tbody>{items.map(item => <tr key={item.value}>
            <td><input type="checkbox" name="route" value={item.value} checked={picked.has(item.value)} disabled={readOnly || pending}
              onChange={event => toggle(item.value, event.target.checked)} aria-label={`${item.label} · ${item.model} · ${item.server} 고르기`} /></td>
            <th scope="row" title={item.routeId}>{item.label}{item.label !== item.routeId && <small>{item.routeId}</small>}</th>
            <td className="devlim-model">{item.model}</td>
            <td>{item.server}</td>
            <td title={item.detail}>{item.reason}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="devlim-acts devlim-acts-start">
        {!asking
          ? <button type="button" className="devlim-btn devlim-danger" disabled={readOnly || pending || !chosen.length} onClick={() => setAsking(true)}>선택한 {chosen.length}개 정리</button>
          : <span className="devlim-confirm" role="group" aria-label="옛 정책 경로 정리 확인">
            <span>정책에서 {chosen.length}개 경로를 뺍니다</span>
            <button type="submit" className="devlim-btn devlim-danger devlim-solid" disabled={pending || !chosen.length}>{pending ? "정리 중…" : "정말 정리"}</button>
            <button type="button" className="devlim-btn" onClick={() => setAsking(false)} disabled={pending}>취소</button>
          </span>}
        {readOnly && <span className="devlim-muted">읽기 전용입니다.</span>}
      </div>
    </form>}
    {state && <div className="devlim-panel-body">
      {state.ok && state.message && <p role="status">{state.message}</p>}
      {state.issues?.map(text => <p key={text} role="alert" className="devlim-refusal">{text}</p>)}
    </div>}
  </section>;
}
