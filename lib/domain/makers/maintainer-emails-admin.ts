import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { repositoryMaintainerEmails } from "@/lib/db/maintainer-email-schema";
import { aiLevelRepositoryKey } from "@/lib/domain/evidence/ai-level-store";

/**
 * 관리자 화면 전용 — 저장소 커밋 작성자 이메일(0186)을 읽는 유일한 곳. 공개 화면·공개 API 에서 부르지 않는다
 * (tests/maintainer-email-boundary.test.ts 가 이 파일과 표를 부르는 곳을 관리자 경로로 묶는다). 부르는 쪽이 먼저 관리자 확인을 한다.
 */
export type MaintainerEmailAdminRow = {
  email: string; name: string | null; login: string | null; commits: number; firstSeenAt: Date; lastSeenAt: Date;
};
export type MaintainerEmailAdminView = { repositoryKey: string | null; rows: MaintainerEmailAdminRow[] };

export async function maintainerEmailsForRepoUrl(repoUrl: string | null | undefined): Promise<MaintainerEmailAdminView> {
  const repositoryKey = aiLevelRepositoryKey(repoUrl);
  if (!repositoryKey) return { repositoryKey: null, rows: [] };
  const rows = await db.select({ email: repositoryMaintainerEmails.email, name: repositoryMaintainerEmails.authorName,
    login: repositoryMaintainerEmails.authorLogin, commits: repositoryMaintainerEmails.commitCount,
    firstSeenAt: repositoryMaintainerEmails.firstSeenAt, lastSeenAt: repositoryMaintainerEmails.lastSeenAt })
    .from(repositoryMaintainerEmails).where(eq(repositoryMaintainerEmails.repositoryKey, repositoryKey))
    .orderBy(desc(repositoryMaintainerEmails.lastSeenAt), desc(repositoryMaintainerEmails.commitCount), repositoryMaintainerEmails.email).limit(50);
  return { repositoryKey, rows };
}
