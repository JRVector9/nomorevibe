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
  const [row] = await db.select({ level: repositoryAiLevels.level, clients: repositoryAiLevels.clients, checkedAt: repositoryAiLevels.checkedAt })
    .from(repositoryAiLevels).where(eq(repositoryAiLevels.repositoryKey, key)).limit(1);
  if (!row) return { checked: false, level: null, clients: [], checkedAt: null };
  return { checked: true, level: isAiLevel(row.level) ? row.level : null, clients: row.clients, checkedAt: row.checkedAt };
}
