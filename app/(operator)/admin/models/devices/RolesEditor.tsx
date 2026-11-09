import type { DeviceRoleView } from "@/lib/operations/admin-capacity-devices";

const TH = "py-2 pr-3 text-[13px] font-semibold text-fg-3";
const TD = "py-2 pr-3 align-top";
export const RANK_INPUT = "w-16 rounded border border-line bg-bg px-2 py-1 text-right tabular-nums";
const ROUTE_INPUT = "w-56 rounded border border-line bg-bg px-2 py-1 font-mono";

/**
 * 역할 순서 — 경로(route) 마다 숫자 순위 하나. 끌어 놓기 없이 숫자만 적는다(1 = 우선 역할, 여러 경로가 1 을 가질 수 있다; 비우면 순위 없음 = 최하위 32767).
 * 칸 이름 rank:<routeId> 는 lib/operations/admin-capacity-devices.ts capacityDeviceInputFromForm 과 짝이다. 정책에 없는 경로는 extraRoute:<i>·extraRank:<i> 로 더한다.
 */
export function RolesEditor({ roles, readOnly, extraRows = 1 }: { roles: DeviceRoleView[]; readOnly?: boolean; extraRows?: number }) {
  return <div className="grid gap-1">
    <h3 className="text-[15px] font-semibold">역할 순서</h3>
    <p className="text-[13px] text-fg-3">1 = 우선 역할(여러 경로 가능). 우선 역할이 바쁘면(대기·예약·진행·유휴 시간 안 종료) 2 이상 역할의 합계는 「낮은 순위 평소 상한」까지만 들어오고,
      우선 역할이 유휴면 칸 수 − 비워 둘 칸까지 빌려 씁니다. 비우면 순위 없음(최하위)입니다. 우선 역할은 상한·비워 둘 칸을 보지 않고 빈 칸을 모두 씁니다.</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-left text-[13px]"><thead><tr className="border-b border-line">
      <th className={TH}>경로(역할)</th><th className={TH}>지금 순위</th><th className={TH}>순위</th></tr></thead>
      <tbody>
        {roles.map(role => <tr key={role.routeId} className="border-b border-line">
          <td className={TD}>{role.label}{role.label !== role.routeId && <><br /><code className="text-[13px] text-fg-3">{role.routeId}</code></>}{!role.inPolicy && <span className="ml-1 text-[13px] text-amber-700">현재 정책에 없음</span>}</td>
          <td className={`${TD} tabular-nums`}>{role.rank === null ? <span className="text-fg-3">순위 없음(최하위)</span> : role.rank}</td>
          <td className={TD}><input name={`rank:${role.routeId}`} defaultValue={role.rank ?? ""} aria-label={`${role.label} 순위`} inputMode="numeric" placeholder="없음"
            disabled={readOnly} className={RANK_INPUT} /></td>
        </tr>)}
        {Array.from({ length: extraRows }, (_, index) => <tr key={`extra-${index}`} className="border-b border-line">
          <td className={TD}><input name={`extraRoute:${index}`} aria-label="추가 경로 id" placeholder="정책에 없는 경로 id" disabled={readOnly} className={ROUTE_INPUT} /></td>
          <td className={`${TD} text-fg-3`}>새 경로</td>
          <td className={TD}><input name={`extraRank:${index}`} aria-label="추가 경로 순위" inputMode="numeric" placeholder="순위" disabled={readOnly} className={RANK_INPUT} /></td>
        </tr>)}
      </tbody></table></div>
  </div>;
}
