import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { repositoryAiLevels } from "@/lib/db/schema";
import { isAiLevel, type AiLevel } from "./ai-level-labels";

/** github.com/owner/name 주소의 저장소 키(소문자) — 다른 곳의 저장소는 null */
export function aiLevelRepositoryKey(repoUrl: string | null | undefined): string | null {
  const match = repoUrl?.trim().match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  if (!match || [match[1], match[2]].some((part) => part === "." || part === "..")) return null;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

export type RepositoryAiLevelView = { checked: boolean; level: AiLevel | null; clients: string[]; checkedAt: Date | null };

/** 상세 '무엇으로 만들었나'가 읽는다 — 검사 전이면 checked=false. 근거(PR·커밋·파일)는 공개 화면에 내지 않는다 */
export async function getRepositoryAiLevel(repoUrl: string | null | undefined): Promise<RepositoryAiLevelView> {
  const key = aiLevelRepositoryKey(repoUrl);
  if (!key) return { checked: false, level: null, clients: [], checkedAt: null };
  const [row] = await db.select({ level: repositoryAiLevels.level, clients: repositoryAiLevels.clients, checkedAt: repositoryAiLevels.checkedAt,
    lastError: repositoryAiLevels.lastError, headSha: repositoryAiLevels.headSha, evidence: repositoryAiLevels.evidence })
    .from(repositoryAiLevels).where(eq(repositoryAiLevels.repositoryKey, key)).limit(1);
  const level = isAiLevel(row?.level) ? row.level : null;
  // 묻다 실패하거나 저장소가 없어 한 번도 판정하지 못한 행(잡이 실패만 적은 행: 오류 있음·head 없음)과,
  // AI 도구 표기 커밋을 아직 확인 중인 행은 '검사 전'이다 — '근거 없음'으로 보이면 안 된다
  if (!row || (level === null && ((row.lastError && !row.headSha) || row.evidence.pendingCommits?.length || row.evidence.pendingPullRequests?.length))) {
    return { checked: false, level: null, clients: [], checkedAt: null };
  }
  return { checked: true, level, clients: row.clients, checkedAt: row.checkedAt };
}

/** 발행할 때 제품에 옮겨 적을 단계 — 잡이 후보를 먼저 보므로 발행 전에 대개 판정이 있다. 없으면 null(잡이 뒤에 채운다) */
export async function storedAiLevel(repositoryKey: string): Promise<AiLevel | null> {
  const [row] = await db.select({ level: repositoryAiLevels.level }).from(repositoryAiLevels)
    .where(eq(repositoryAiLevels.repositoryKey, repositoryKey.toLowerCase())).limit(1);
  return isAiLevel(row?.level) ? row.level : null;
}
