import { refreshCliHostObservation } from "@/lib/operations/cli-host-observation";
import { cliHostTargetFromConnection, type CliHostTarget } from "@/lib/operations/cli-host-target";
import { resolveReviewTaskRanks, secondReviewRanks, type ReviewRankCandidate, type ReviewTaskRoute } from "./review-task-ranks";
import { assertLiveReviewAdapterAllowed } from "./review-fixture-transport";

/**
 * 1차·2차 심사의 OpenCode 순위가 예약 전 계약 확인을 지날 수 있게, claim TX 에 들어가기 전에 그 순위 연결의 호스트 카탈로그로 버전 관측을 채운다
 * (lib/operations/cli-host-observation.ts — 낡았을 때만·연결마다 single-flight·실패 뒤 잠시 쉼). 결과는 돌려주지 않는다: 관측이 없으면 claim 의
 * 사전 확인이 오늘처럼 provider_contract_unavailable 로 미루고(1차는 다음 순위로), 있으면 예약 → 원격 prepare 의 정확한 대조로 간다.
 *
 * - reviewer 를 주면 그 심사자(1차 고른 순위)가 OpenCode 일 때만, 그 모델의 순위 연결로 본다.
 * - 주지 않으면(2차 소비자 — 어느 표인지 claim 안에서야 안다) 그 route 의 쓸 수 있는 OpenCode 순위 연결로 본다. OpenCode 순위가 없으면 아무것도 하지 않는다.
 * - 격리 replay·fixture 범위에서는 호스트를 부르지 않는다.
 */
export async function observeReviewCliHost(routeId: ReviewTaskRoute, reviewer?: { provider: string; model: string }): Promise<void> {
  if (reviewer && reviewer.provider !== "opencode-cli") return;
  try { assertLiveReviewAdapterAllowed(); } catch { return; }
  const resolutions = routeId === "crawl-agent-review" ? [resolveReviewTaskRanks("first-review", 1)] : secondReviewRanks().slots.map(slot => slot.resolution);
  const connections = new Map<string, ReviewRankCandidate["rank"]["connection"]>();
  for (const candidate of resolutions.flatMap(resolution => resolution.candidates)) {
    if (candidate.binding?.provider !== "opencode-cli" || candidate.unusable || reviewer && candidate.binding.identity !== reviewer.model) continue;
    connections.set(candidate.rank.connection.id, candidate.rank.connection);
  }
  for (const connection of connections.values()) {
    // 연결에 주소·키가 없으면 prepare 도 같은 까닭으로 미룬다 — 여기서는 부르지 않는다
    let target: CliHostTarget;
    try { target = cliHostTargetFromConnection(connection); } catch { continue; }
    if (await refreshCliHostObservation(connection.id, () => target)) return;
  }
}
