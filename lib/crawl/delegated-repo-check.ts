import { githubRequest } from "./github";

/**
 * 사람 몫 위임 검수의 승인이 24~72시간 된 근거에 기댈 때, 발행 전에 저장소가 아직 있는지 GitHub 에 한 번 묻는다(2026-11-09 운영자 결정
 * 「해당 레포가 사라졌는지 있는지 봐야」). 발행 경로는 저장된 원본만 보고 GitHub 를 다시 묻지 않는다 — 그래서 여기서 묻는다.
 * 같은 수집 자격·한도(collectorTokens·githubRequest)를 쓴다. 72시간 넘은 근거는 묻지 않고 원본 재수집(수집 잡의 404 처리)으로 보낸다.
 *
 *  present  — 같은 이름의 공개 저장소이고 보관(archived)되지 않았다 → 승인을 적용한다
 *  gone     — 404(삭제 또는 비공개 전환. GitHub 는 둘을 가르지 않는다) → 수집이 404 를 만났을 때처럼 repo_deleted 로 사람에게 넘긴다
 *  changed  — 이름이 바뀌었거나(이전 주소가 새 저장소로 이어진다) 보관됐거나 비공개다 → 승인하지 않고 원본을 다시 받게 한다
 *  deferred — 한도·자격·전송 탈 → 모르는 채로 발행하지 않는다. 시도를 미루고 다시 본다
 */
export type DelegatedRepoCheck = "present" | "gone" | "changed" | "deferred";
export type DelegatedRepoCheckResult = { check: DelegatedRepoCheck; retryAt: Date | null };

const CHECK_TIMEOUT_MS = 8_000;

export async function checkDelegatedRepository(repo: string, signal?: AbortSignal): Promise<DelegatedRepoCheckResult> {
  const result = await githubRequest<Record<string, unknown>>(`/repos/${repo}`, {}, { timeoutMs: CHECK_TIMEOUT_MS, signal });
  if (!result.ok) {
    if (result.error.kind === "not_found") return { check: "gone", retryAt: null };
    const retryAt = result.error.kind === "rate_limited" || result.error.kind === "auth_unavailable" ? result.error.resetAt : null;
    return { check: "deferred", retryAt };
  }
  if (result.status !== 200 || !result.value || typeof result.value.id !== "number") return { check: "deferred", retryAt: null };
  const meta = result.value;
  const same = typeof meta.full_name === "string" && meta.full_name.toLowerCase() === repo.toLowerCase();
  return { check: same && meta.private === false && meta.archived !== true ? "present" : "changed", retryAt: null };
}
