import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { operationsAudit } from "@/lib/db/schema";
import { maintainerEmailDenials, repositoryMaintainerEmails } from "@/lib/db/maintainer-email-schema";
import { aiLevelRepositoryKey } from "@/lib/domain/evidence/ai-level-store";
import {
  MAINTAINER_EMAIL_DENY_HASH, MAINTAINER_EMAIL_DENY_HASH_PREFIX, MAINTAINER_EMAIL_LOCK, maintainerEmailDenyHash, maskMaintainerEmail,
} from "@/lib/domain/makers/maintainer-emails";
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

export type MaintainerEmailDenyResult = { deletedRows: number; repositories: number; alreadyDenied: boolean };

/**
 * 「지우고 다시 모으지 않기」 — 주소를 표 전체(모든 저장소)에서 바로 지우고, 거부 목록에 해시를 넣는다(다음 수집부터 다시 모으지 않는다).
 * 지우기는 주소가 아니라 해시로 한다 — DB 가 저장된 주소마다 같은 해시(maintainerEmailDenyHash 와 같은 접두어·정규화의 sha256)를 셈해 맞는 행을 지운다.
 * 그래서 화면을 그린 뒤 그 제품의 행이 사라졌어도(저장소 주소가 바뀜·보관 정리 등) 다른 저장소에 남은 같은 주소까지 지우고, 주소는 문장의 bind 값으로도
 * 보내지 않는다(느린 문장 로그에 남지 않는다). 표는 저장소당 몇 행이라 전체를 훑어도 싸다.
 * 수집 쓰기(ai-level-refresh writeContacts)와 같은 advisory 잠금을 배타로 잡는다 — 진행 중인 수집 쓰기가 끝난 뒤 지우고, 그 뒤 수집은 거부 목록을 본다.
 * 작업 로그(operations_audit)에는 주소·해시를 남기지 않는다 — 그 제품의 저장소 키와 지운 행·저장소 수만.
 */
export async function denyMaintainerEmail(input: { slug: string; repoUrl: string | null | undefined; denyKey: string; actor: string }): Promise<MaintainerEmailDenyResult> {
  if (!MAINTAINER_EMAIL_DENY_HASH.test(input.denyKey)) throw new Error("maintainer_email_deny_key_invalid");
  const repositoryKey = aiLevelRepositoryKey(input.repoUrl);
  return onPrimary(() => db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${MAINTAINER_EMAIL_LOCK}))`);
    const inserted = await tx.insert(maintainerEmailDenials).values({ emailHash: input.denyKey }).onConflictDoNothing()
      .returning({ hash: maintainerEmailDenials.emailHash });
    const deleted = await tx.execute<{ repository_key: string }>(sql`DELETE FROM repository_maintainer_emails
      WHERE encode(sha256(convert_to(${MAINTAINER_EMAIL_DENY_HASH_PREFIX} || email, 'UTF8')), 'hex') = ${input.denyKey}
      RETURNING repository_key`);
    const result: MaintainerEmailDenyResult = { deletedRows: deleted.length, repositories: new Set(deleted.map((row) => row.repository_key)).size,
      alreadyDenied: inserted.length === 0 };
    await tx.insert(operationsAudit).values(await adminAuditRow(input.actor, { action: MAINTAINER_EMAIL_DENY_ACTION, target: input.slug,
      detail: { repositoryKey, ...result } }));
    return result;
  }));
}
