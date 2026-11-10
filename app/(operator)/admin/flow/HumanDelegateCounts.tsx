import Link from "next/link";
import { DELEGATE_GROUP_GUIDE, delegateGroupHref, type DelegateGroup } from "@/lib/crawl/delegate-groups";
import type { HumanDelegateSummary } from "@/lib/operations/human-delegate-summary";

/** 운영 홈 「사람이 처리할 일」에 줄로 거는 AI 위임 결과 갈래 — 여섯 갈래 모두(2026-11-10 시안 B: 묶음 상자 안의 줄) */
export const FLOW_DELEGATE_GROUPS = ["abstained", "low_confidence", "human_only", "legacy", "admin", "unreviewed"] as const satisfies readonly DelegateGroup[];
export const flowDelegateSlot = (group: DelegateGroup) => `delegate-${group}`;

/** 갈래 하나의 수 — 누르면 그 갈래만 남은 사람 몫 목록이 열린다. 못 읽으면 미확인 */
export async function HumanDelegateCount({ read, group }: { read: Promise<HumanDelegateSummary | null>; group: DelegateGroup }) {
  const summary = await read;
  if (!summary) return <>미확인</>;
  const count = summary.counts[group].toLocaleString("ko-KR");
  return <Link prefetch={false} className="text-button" href={delegateGroupHref(group)}
    aria-label={`${DELEGATE_GROUP_GUIDE[group].label} ${count}건 목록 보기`}>{`${count}건 →`}</Link>;
}
