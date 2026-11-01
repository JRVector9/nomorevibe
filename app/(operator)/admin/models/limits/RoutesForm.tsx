"use client";
import Link from "next/link";
import type { LadderRow, RouteRow } from "@/lib/operations/admin-runtime-settings";
import { GroupForm, TD, TH, ValueCell } from "./fields";

/**
 * 경로 한도(routes) — 용도별 출력 토큰 상한·동시 호출·호출 상한과 기한 사다리. 모델 자체의 상한(등록부)은 읽기 전용으로 옆에 보인다:
 * 실제 호출은 둘 중 작은 값을 쓴다(lib/llm/model-registry.ts modelLimits·modelCallTimeoutMs).
 */
export function RoutesForm({ routes, ladders, revision, readOnly }: { routes: RouteRow[]; ladders: LadderRow[]; revision: number | null; readOnly?: boolean }) {
  return <GroupForm group="routes" revision={revision} readOnly={readOnly}
    footer={<Link href="/admin/models/contracts" className="text-[13px] underline">모델 자체의 상한은 모델 연결 → 등록부 덮어쓰기</Link>}>
    <div className="overflow-x-auto"><table className="w-full min-w-[880px] text-left text-[13px]"><thead><tr className="border-b border-line">
      <th className={TH}>경로</th><th className={TH}>출력 토큰 상한</th><th className={TH}>동시 호출</th><th className={TH}>호출 상한(초)</th><th className={TH}>모델 상한(등록부)</th></tr></thead>
      <tbody>{routes.map(row => <tr key={row.route} className="border-b border-line">
        <td className={TD}>{row.label}<br /><code className="text-[13px] text-fg-3">{row.route}</code></td>
        <td className={TD}>{row.maxTokens ? <ValueCell field={row.maxTokens} readOnly={readOnly} unit="" /> : <span className="text-fg-3">—</span>}</td>
        <td className={TD}>{row.concurrency ? <ValueCell field={row.concurrency} readOnly={readOnly} unit="" /> : <span className="text-fg-3">—</span>}</td>
        <td className={TD}>{row.timeout ? <ValueCell field={row.timeout} readOnly={readOnly} /> : <span className="text-[13px] text-fg-3">{row.timeoutNote ?? "—"}</span>}</td>
        <td className={`${TD} text-[13px] text-fg-3`}>{row.modelCeiling ?? "이 경로를 맡은 등록부 모델 없음"}</td>
      </tr>)}</tbody></table></div>
    <h3 className="mt-2 text-[15px] font-semibold">기한 사다리</h3>
    <p className="text-[13px] text-fg-3">기한 칸(엔진·중계·게이트웨이·클라이언트)은 선언입니다. 이 숫자를 강제하는 게이트웨이는 없습니다. 순서는 엔진 &lt; 중계 &lt; 게이트웨이 &lt; 클라이언트(층 사이 2초 이상)이고,
      클라이언트 기한이 그 경로의 호출 상한입니다. 호출이 열리는지는 「모델 연결」의 직접 연결 계약이 정합니다. 새 값은 새 호출부터 적용됩니다.</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-[13px]"><thead><tr className="border-b border-line">
      <th className={TH}>경로</th><th className={TH}>엔진(초)</th><th className={TH}>중계(초)</th><th className={TH}>게이트웨이(초)</th><th className={TH}>클라이언트(초)</th></tr></thead>
      <tbody>{ladders.map(row => <tr key={row.route} className="border-b border-line">
        <td className={TD}>{row.label}<br /><code className="text-[13px] text-fg-3">{row.route}</code></td>
        <td className={TD}><ValueCell field={row.fields.engineMs} readOnly={readOnly} /></td>
        <td className={TD}><ValueCell field={row.fields.relayMs} readOnly={readOnly} /></td>
        <td className={TD}><ValueCell field={row.fields.gatewayMs} readOnly={readOnly} /></td>
        <td className={TD}><ValueCell field={row.fields.clientMs} readOnly={readOnly} /></td>
      </tr>)}</tbody></table></div>
  </GroupForm>;
}
