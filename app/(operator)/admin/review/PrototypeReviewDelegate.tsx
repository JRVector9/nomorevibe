import Link from "next/link";
import { DELEGATE_GROUPS, DELEGATE_GROUP_GUIDE, delegateGroupCounts, type DelegateGroup, type DelegateGroups } from "@/lib/crawl/delegate-groups";

const n = (value: number) => value.toLocaleString("ko-KR");

/**
 * 사람 몫의 「AI 위임 결과」 갈래 칩 — 2026-11-10 운영자 요청: 근거 부족은 따로 사람이 승인하는 목록으로.
 * 칸의 수는 갈래만 뺀 지금 조건(단계·갈래·AI·2차) 안의 수라, 검색·기간 조건이 없으면 그 칸을 누른 목록의 전체 수와 같다.
 * 읽기는 이 칸을 그릴 때 시작하고(load — 목록이 갈래로 거를 때 이미 읽었으면 그 값을 쓴다), 못 읽으면 미확인으로 말하며 목록은 그대로 둔다.
 */
export async function PrototypeReviewDelegateNav({ load, scope, active, hrefs, narrowed }: {
  load: () => Promise<DelegateGroups>; scope: number[] | undefined; active: DelegateGroup | "";
  hrefs: Record<DelegateGroup | "all", string>; narrowed: boolean;
}) {
  const groups = await load().catch(() => null);
  if (!groups) return <p className="small muted" role="status">AI 위임 결과 갈래를 읽지 못했습니다 — 갈래별 수 미확인. 목록은 그대로입니다.</p>;
  const counts = delegateGroupCounts(groups, scope);
  return <>
    <nav className="segmented" aria-label="AI 위임 결과">
      <Link prefetch={false} href={hrefs.all} aria-current={active ? undefined : "page"}>전체</Link>
      {DELEGATE_GROUPS.map(group => <Link key={group} prefetch={false} href={hrefs[group]} title={DELEGATE_GROUP_GUIDE[group].hint}
        aria-current={active === group ? "page" : undefined} data-delegate-group={group}>{`${DELEGATE_GROUP_GUIDE[group].label} ${n(counts[group])}건`}</Link>)}
    </nav>
    <p className="small muted">{active ? DELEGATE_GROUP_GUIDE[active].hint
      : "근거 부족은 AI 위임 검수가 근거가 모자라 판단을 보류한 후보입니다 — 사람이 근거를 보고 승인·반려하는 목록입니다. 칸을 누르면 그 갈래만 남습니다."}
      {narrowed ? " 칸의 수는 검색·기간 조건을 걸기 전의 수입니다." : ""}</p>
  </>;
}
