import { desc, eq } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { productMakerMembers } from "@/lib/db/me-schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import { formatDetailTime } from "@/lib/format/time";
import { Panel } from "@/components/Panel";

const METHOD_LABELS: Record<string, string> = {
  github_repo_owner: "GitHub 저장소 주인", github_repo_admin: "GitHub 저장소 관리자", repo_file: "저장소 확인 파일", edit_token: "수정 키", admin: "관리자",
};

/** 운영자 확인(마이페이지 MY5) — 이 제품을 운영자로 확인한 계정. 풀린 행도 사유와 함께 */
export async function makerMembersOf(slug: string) {
  return onPrimary(() => db.select({
    userId: productMakerMembers.userId, displayName: publicUsers.displayName, role: productMakerMembers.role, method: productMakerMembers.method,
    githubUserId: productMakerMembers.githubUserId, verifiedAt: productMakerMembers.verifiedAt, recheckAt: productMakerMembers.recheckAt,
    revokedAt: productMakerMembers.revokedAt, revokedReason: productMakerMembers.revokedReason,
  }).from(productMakerMembers).innerJoin(products, eq(products.id, productMakerMembers.productId))
    .innerJoin(publicUsers, eq(publicUsers.id, productMakerMembers.userId))
    .where(eq(products.slug, slug)).orderBy(desc(productMakerMembers.verifiedAt)).limit(20));
}

export function MakerMembersPanel({ rows }: { rows: Awaited<ReturnType<typeof makerMembersOf>> | null }) {
  return (
    <Panel title="운영자 확인" note="GitHub 로그인으로 저장소 주인을 확인한 계정입니다. 30일마다 다시 확인하고, 주인이 바뀌면 풀립니다.">
      {rows === null ? <p className="text-[13px] text-down">운영자 확인 기록을 읽지 못했습니다.</p>
        : rows.length === 0 ? <p className="text-[13px] text-fg-3">확인한 계정이 없습니다.</p> : (
        <ul className="space-y-1.5 text-[13px]">{rows.map((row) => (
          <li key={row.userId} className="rounded-[10px] bg-bg-soft px-3 py-2">
            <strong>{row.displayName}</strong>
            <span className="text-fg-2"> · 계정 #{row.userId} · {row.role === "owner" ? "주인" : "편집자"} · {METHOD_LABELS[row.method] ?? row.method}</span>
            {row.githubUserId !== null && <span className="font-mono text-fg-3"> · GitHub {row.githubUserId}</span>}
            <span className="text-fg-2"> · 확인 {formatDetailTime(row.verifiedAt)}</span>
            {row.revokedAt ? <span className="font-semibold text-down"> · 풀림 {formatDetailTime(row.revokedAt)} ({row.revokedReason ?? "—"})</span>
              : <span className="text-fg-3"> · 다음 재확인 {formatDetailTime(row.recheckAt)}</span>}
          </li>
        ))}</ul>
      )}
    </Panel>
  );
}
