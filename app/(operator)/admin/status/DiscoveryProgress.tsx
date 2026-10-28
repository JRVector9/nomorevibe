import type { ReplicaRead } from "@/lib/operations/replica-hold";
import { replicaHoldText } from "@/lib/operations/replica-hold";
import type { DiscoveryProgressReport } from "@/lib/operations/discovery-progress";
import { formatListTime } from "@/lib/format/time";
import { ScrollTable } from "../components/ScrollTable";

const LANES = { latest: "최신", full: "전체", korean: "한국어 전체기간" };
const BLOCKERS: Record<string, string> = { queue_cap: "대기열 상한", rate_cap: "신규 적재 한도", api_wait: "GitHub 재시도 대기", auth: "GitHub 인증 확인", incomplete: "불완전 구간 재시도" };
const n = (v: number) => v.toLocaleString("ko-KR");
const date = (v: string | null) => v ? v.replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : "미확인";

export function DiscoveryProgress({ read }: { read: ReplicaRead<DiscoveryProgressReport> }) {
  if (!read.ok) return <section className="dash-card"><div className="dash-card-h"><h2>GitHub 탐색 진척</h2></div>
    <p className="crawler-notice">탐색 계측 미확인 · {replicaHoldText(read.reason)}. 미확인은 탐색·신규 적재 0건을 뜻하지 않습니다.</p></section>;
  const { rows, at, truncated } = read.value;
  return <section className="dash-card">
    <div className="dash-card-h"><h2>GitHub 탐색 진척</h2><small>DB 기준 {date(at)}</small></div>
    <p>최신·전체 탐색에 검색 페이지와 실행시간을 나눠 배정하고, 남는 페이지를 재사용합니다. 최근 약 1시간은 1분 묶음 61칸(60~61분)이며, 같은 저장소가 다른 검색어에 나타나면 각각 셉니다.</p>
    {truncated && <p className="crawler-notice">최근 관측 512개만 표시합니다. 전체 합계로 해석하지 마세요.</p>}
    {rows.length === 0 ? <p className="crawler-muted">아직 새 탐색 계측이 없습니다. 배포·가동 후 실제 탐색 페이지를 처리하면 표시됩니다.</p> : <ScrollTable label="GitHub 서버·검색어별 탐색 진척"><table className="crawler-table">
      <thead><tr><th scope="col">서버 · 경로 · 검색어</th><th scope="col">최근 약 1시간 탐색</th><th scope="col">신규·중복</th><th scope="col">한국어 판별</th><th scope="col">현재 구간</th><th scope="col">완료한 날짜 · 지연</th><th scope="col">진척·제한 사유</th></tr></thead>
      <tbody>{rows.map(row => <tr key={`${row.worker}:${row.lane}:${row.signal}`}>
        <th scope="row"><strong>{row.worker}</strong><small>{LANES[row.lane]} · {row.signal}</small></th>
        <td>요청 {n(row.hour.searchRequests)} · 페이지 {n(row.hour.pagesVisited)}<small>응답 재사용 {n(row.hour.cacheHits)} · 확인 {n(row.hour.returned)}</small></td>
        <td>신규 {n(row.hour.discovered)} · 기존 {n(row.hour.existing)}<small>페이지 내부 중복 {n(row.hour.pageDuplicates)}{row.hour.examined > 0 && ` · 기존 비율 ${(100 * row.hour.existing / row.hour.examined).toFixed(1)}%`}</small></td>
        <td>{row.lane === "korean" ? <>통과 {n(row.hour.koreanYes)} · 제외 {n(row.hour.koreanNo)}<small>확인 실패·재시도 {n(row.hour.koreanUnknown)}</small></> : "해당 없음"}</td>
        <td>{row.window ? <>{date(row.window.from)}<small>~ {date(row.window.to)} · {row.page ?? "?"}페이지</small></> : "미확인"}</td>
        <td>{date(row.completedThrough)}<small>{row.lagMinutes === null ? "완료 범위 미확인" : `현재까지 ${n(row.lagMinutes)}분 차이`}</small></td>
        <td>페이지 진척 {formatListTime(row.lastProgressAt, at, "기록 없음")}<small>{row.blockedBy ? BLOCKERS[row.blockedBy] : "기록된 제한 없음"}</small>{row.pendingSince && <small>미완료 시작 {formatListTime(row.pendingSince, at)}</small>}<small>관측 {formatListTime(row.observedAt, at)}</small></td>
      </tr>)}</tbody>
    </table></ScrollTable>}
    <p className="crawler-muted crawler-footnote">완료한 날짜는 모든 페이지·분할 구간을 처리했다고 기록된 시점만 표시합니다. 과거 구간 지연과 워커 장애는 구분하며, 불완전 검색을 완료로 세지 않습니다. 새 AI 제작 근거는 기존 저장소에서도 보존합니다.</p>
  </section>;
}
