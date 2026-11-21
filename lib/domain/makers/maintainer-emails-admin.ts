import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { operationsAudit } from "@/lib/db/schema";
import { maintainerEmailDenials, repositoryMaintainerEmails } from "@/lib/db/maintainer-email-schema";
import { aiLevelRepositoryKey } from "@/lib/domain/evidence/ai-level-store";
import { MAINTAINER_EMAIL_DENY_HASH, MAINTAINER_EMAIL_LOCK, maintainerEmailDenyHash, maskMaintainerEmail } from "@/lib/domain/makers/maintainer-emails";
import { adminAuditRow } from "@/lib/operations/admin-log";

/**
 * 관리자 화면 전용 — 저장소 제작자 커밋 이메일(0194)을 읽고 지우는 유일한 곳. 공개 화면·공개 API 에서 부르지 않는다
 * (tests/maintainer-email-boundary.test.ts 가 이 파일과 표를 부르는 곳을 관리자 경로로 묶는다). 부르는 쪽이 먼저 관리자 확인을 한다.
 */
export type MaintainerEmailAdminRow = {
  email: string; name: string | null; login: string | null; commits: number; firstSeenAt: Date; lastSeenAt: Date;
  /** 「지우고 다시 모으지 않기」 양식이 주소 대신 보내는 값(거부 목록 열쇠) — 주소가 요청 본문에 실리지 않는다 */
  denyKey: string;
  /** 확인 창에 보이는 가린 주소 */
  masked: string;
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
  return { repositoryKey, rows: rows.map((row) => ({ ...row, denyKey: maintainerEmailDenyHash(row.email), masked: maskMaintainerEmail(row.email) })) };
}

export const MAINTAINER_EMAIL_DENY_ACTION = "maintainer-email-deny";

export type MaintainerEmailDenyResult = { deletedRows: number; alreadyDenied: boolean; found: boolean };

/**
 * 「지우고 다시 모으지 않기」 — 주소를 모든 저장소에서 바로 지우고, 거부 목록에 해시를 넣는다(다음 수집부터 다시 모으지 않는다).
 * 양식은 주소 대신 그 제품 저장소에 남은 주소의 해시(denyKey)를 보낸다. 해시가 그 저장소의 주소와 맞지 않아도 거부 목록에는 넣는다(이미 지워진 주소의 재요청).
 * 수집 쓰기(ai-level-refresh writeContacts)와 같은 advisory 잠금을 배타로 잡는다 — 진행 중인 수집 쓰기가 끝난 뒤 지우고, 그 뒤 수집은 거부 목록을 본다.
 * 작업 로그(operations_audit)에는 주소·해시를 남기지 않는다 — 저장소 키와 지운 행 수만.
 */
export async function denyMaintainerEmail(input: { slug: string; repoUrl: string | null | undefined; denyKey: string; actor: string }): Promise<MaintainerEmailDenyResult> {
  if (!MAINTAINER_EMAIL_DENY_HASH.test(input.denyKey)) throw new Error("maintainer_email_deny_key_invalid");
  const repositoryKey = aiLevelRepositoryKey(input.repoUrl);
  return onPrimary(() => db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${MAINTAINER_EMAIL_LOCK}))`);
    const candidates = repositoryKey ? await tx.select({ email: repositoryMaintainerEmails.email }).from(repositoryMaintainerEmails)
      .where(eq(repositoryMaintainerEmails.repositoryKey, repositoryKey)) : [];
    const address = candidates.find((row) => maintainerEmailDenyHash(row.email) === input.denyKey)?.email ?? null;
    const inserted = await tx.insert(maintainerEmailDenials).values({ emailHash: input.denyKey }).onConflictDoNothing()
      .returning({ hash: maintainerEmailDenials.emailHash });
    const deleted = address ? await tx.delete(repositoryMaintainerEmails).where(eq(repositoryMaintainerEmails.email, address))
      .returning({ repositoryKey: repositoryMaintainerEmails.repositoryKey }) : [];
    const result: MaintainerEmailDenyResult = { deletedRows: deleted.length, alreadyDenied: inserted.length === 0, found: address !== null };
    await tx.insert(operationsAudit).values(await adminAuditRow(input.actor, { action: MAINTAINER_EMAIL_DENY_ACTION, target: input.slug,
      detail: { repositoryKey, ...result, repositories: new Set(deleted.map((row) => row.repositoryKey)).size } }));
    return result;
  }));
}
