import type { RepoStatus } from "@/lib/db/schema";
import { githubGraphql, type GitHubFailure, type GraphqlError } from "./github";

/**
 * 저장소 여러 개를 GraphQL 한 번에 묻는다 — 공개 제품 전부의 저장소를 하루 한 번 보는 데 쓴다(product-stars-refresh).
 *
 * 2026-10-08 실측: 별칭 100개짜리 질의가 1점, 4.4초. REST 로 하나씩 물으면 100번(100점)이다.
 * 없는 저장소는 그 별칭이 null 이고 errors 에 {type:"NOT_FOUND", path:[별칭]} 이 붙는다(공개 제품 100개 중 4개).
 * 이름이 바뀐 저장소는 옛 이름으로 물어도 새 nameWithOwner 로 돌려준다(twitter/bootstrap → twbs/bootstrap 확인).
 * 빈 저장소는 isEmpty=true, defaultBranchRef=null 이다.
 */
export const REPOSITORY_BATCH = 100;

export type RepositoryRef = { owner: string; name: string };

/** 저장소 객체를 받았을 때 함께 적는 것 */
export type RepositoryFacts = {
  stars: number | null;
  ownerType: "User" | "Organization" | null;
  archived: boolean;
  /** ISO 시각. 빈 저장소는 없다 */
  pushedAt: string | null;
  /** 물은 이름과 다르게(대소문자 말고) 돌아온 owner/name — 이름이 바뀌었거나 옮겨 갔다 */
  renamedTo: string | null;
};

export type RepositoryCheck = {
  /** null 이면 이번 답으로는 모른다 — 지난 답을 그대로 둔다(시간 초과·그 밖의 오류) */
  status: RepoStatus | null;
  facts: RepositoryFacts | null;
};

export type RepositoryBatchResult =
  | { ok: true; checks: RepositoryCheck[]; rateLimit: { remaining: number; resetAt: string | null } | null }
  | { ok: false; error: GitHubFailure };

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const FIELDS = "nameWithOwner isArchived isEmpty isDisabled isLocked pushedAt stargazerCount defaultBranchRef { name } owner { __typename }";
const alias = (index: number) => `r${index}`;

/** owner·name 은 githubOwnerFromRepositoryUrl 이 이미 걸렀지만 질의에 바로 넣으므로 여기서도 막는다 */
export function repositoryBatchQuery(repos: readonly RepositoryRef[]): string {
  if (repos.length === 0 || repos.length > REPOSITORY_BATCH) throw new Error("repository_batch_size");
  const parts = repos.map((repo, index) => {
    if (!SEGMENT.test(repo.owner) || !SEGMENT.test(repo.name)) throw new Error("repository_batch_name");
    return `${alias(index)}: repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) { ...R }`;
  });
  return `query { rateLimit { cost remaining resetAt } ${parts.join(" ")} }\nfragment R on Repository { ${FIELDS} }`;
}

const TRANSIENT: RepositoryCheck = { status: null, facts: null };

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * 별칭 하나의 답을 상태로 바꾼다.
 * - 객체: 비활성·잠김 → blocked, 빈 저장소(isEmpty 또는 기본 브랜치 없음) → empty, 나머지 → ok
 * - null + NOT_FOUND → not_found, null + FORBIDDEN → blocked
 * - 그 밖의 오류나 깨진 객체 → 모름(null). 상태를 바꾸지 않는다
 */
export function mapRepositoryBatch(repos: readonly RepositoryRef[], data: Record<string, unknown> | null,
  errors: readonly GraphqlError[]): RepositoryCheck[] {
  return repos.map((repo, index) => {
    const key = alias(index);
    const node = asObject(data?.[key]);
    if (node) {
      const nameWithOwner = node.nameWithOwner;
      if (typeof nameWithOwner !== "string" || !nameWithOwner.includes("/")) return TRANSIENT;
      const stars = node.stargazerCount;
      const ownerType = asObject(node.owner)?.__typename;
      const pushedAt = typeof node.pushedAt === "string" && Number.isFinite(Date.parse(node.pushedAt)) ? node.pushedAt : null;
      const status: RepoStatus = node.isDisabled === true || node.isLocked === true ? "blocked"
        : node.isEmpty === true || !asObject(node.defaultBranchRef) ? "empty" : "ok";
      return {
        status,
        facts: {
          stars: typeof stars === "number" && Number.isInteger(stars) && stars >= 0 && stars <= 2147483647 ? stars : null,
          ownerType: ownerType === "User" || ownerType === "Organization" ? ownerType : null,
          archived: node.isArchived === true,
          pushedAt,
          renamedTo: nameWithOwner.toLowerCase() === `${repo.owner}/${repo.name}`.toLowerCase() ? null : nameWithOwner.slice(0, 160),
        },
      };
    }
    const error = errors.find((item) => Array.isArray(item.path) && item.path[0] === key);
    if (error?.type === "NOT_FOUND") return { status: "not_found", facts: null };
    if (error?.type === "FORBIDDEN") return { status: "blocked", facts: null };
    return TRANSIENT;
  });
}

/** 한 묶음(최대 100개). 한도·인증 실패는 묶음 전체의 실패로 돌려준다 — 부른 쪽이 기다린다 */
export async function checkRepositories(repos: readonly RepositoryRef[], options: { timeoutMs?: number } = {}): Promise<RepositoryBatchResult> {
  const result = await githubGraphql<Record<string, unknown>>(repositoryBatchQuery(repos), options);
  if (!result.ok) return result;
  // 별칭 오류 없이 data 가 통째로 없으면(질의 오류·서버 시간 초과) 묶음 전체를 모른다
  if (!result.data) return { ok: false, error: { kind: "invalid_response" } };
  const limit = asObject(result.data.rateLimit);
  const remaining = limit?.remaining;
  return {
    ok: true,
    checks: mapRepositoryBatch(repos, result.data, result.errors),
    rateLimit: typeof remaining === "number" ? { remaining, resetAt: typeof limit?.resetAt === "string" ? limit.resetAt : null } : null,
  };
}
