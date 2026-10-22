import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { githubIntegrationAdminRows } from "@/lib/domain/github-webhooks/admin";
import { adminRecoveryCsrf } from "@/lib/domain/github-webhooks/admin-auth";
import { formatListTime } from "@/lib/format/time";
import { parseGithubRepository } from "@/lib/github/repositories";
import { requeryGithubIntegrationAction, retransmitGithubIntegrationAction } from "./actions";
import { PageStamp } from "@/app/(operator)/admin/components/PageStamp";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "GitHub 연동 — NoMoreVibe", robots: { index: false, follow: false } };
const STATES: Record<string, string> = { queued: "대기", sending: "전송 중", delivered: "전송 확인", retry_wait: "재시도 대기", uncertain: "결과 확인 필요", blocked: "권한·정책 차단", cancelled: "전송 취소" };
const EXTERNAL: Record<string, string> = { open: "열림", closed: "닫힘", deleted: "조회되지 않음", unknown: "확인되지 않음" };
function HiddenFields({ row, csrfToken, expiresAt }: { row: Awaited<ReturnType<typeof githubIntegrationAdminRows>>[number]; csrfToken: string; expiresAt: number }) {
  return <><input type="hidden" name="requestId" value={randomUUID()} /><input type="hidden" name="outboxId" value={row.id} /><input type="hidden" name="expectedDispatchId" value={row.dispatchId} /><input type="hidden" name="csrfToken" value={csrfToken} /><input type="hidden" name="csrfExpiresAt" value={expiresAt} /></>;
}
export default async function GithubIntegrationsPage() {
  const admin = await currentAdmin(); if (!admin) redirect("/admin/login");
  const secret = authSecret(); if (!secret) throw new Error("admin_auth_unconfigured");
  const csrfToken = adminRecoveryCsrf(admin, secret), rows = await githubIntegrationAdminRows(), now = new Date();
  return <main className="mx-auto max-w-4xl space-y-5 p-5"><PageStamp />
    <h1 className="text-[22px] font-semibold">GitHub 연동</h1>
    <p className="text-[14px] leading-6 text-fg-2">최근 전송 100건입니다. 재조회는 GitHub의 현재 상태를 확인합니다. 이슈가 닫혀도 작성자의 문제가 해결됐다고 판단하지 않습니다.</p>
    {rows.length === 0 && <p className="text-[14px]">전송 기록이 없습니다.</p>}
    {rows.map(row => {
      const repository = parseGithubRepository(row.repositoryUrl);
      const canRetransmit = row.bindingEnabled && ["uncertain", "blocked", "cancelled"].includes(row.state);
      const issueUrl = repository && row.githubIssueUrl?.startsWith(repository.htmlUrl + "/issues/") && /^\d+$/.test(row.githubIssueUrl.slice((repository.htmlUrl + "/issues/").length)) ? row.githubIssueUrl : null;
      return <section key={row.id} className="space-y-3 rounded-xl border border-line p-4">
        <div className="flex flex-wrap justify-between gap-2"><Link prefetch={false} href={`/p/${row.productSlug}`} className="font-medium underline">{row.productName}</Link><span className="text-[14px]">{STATES[row.state]}</span></div>
        <p className="text-[13px] text-fg-2">대상 {row.repositoryFullName} · 저장소 ID {row.repositoryId} · 설치 {row.installationId} · 연결 버전 {row.bindingRevision}</p>
        <p className="text-[13px] text-fg-2">마지막 오류: {row.lastErrorCode ?? "없음"} · 확인: {formatListTime(row.lastCheckedAt, now, "없음")} · GitHub 이슈: {EXTERNAL[row.externalIssueState]}</p>
        <div className="flex gap-4 text-[14px]"><Link prefetch={false} href={`/feedback/${row.feedbackId}`} className="underline">사이트 원문</Link>{issueUrl && <a href={issueUrl} target="_blank" rel="noopener noreferrer" className="underline">GitHub 이슈</a>}</div>
        {!row.bindingEnabled && <p className="text-[13px] text-fg-2">제작자가 연결을 다시 확인해야 새 전송을 요청할 수 있습니다. 이미 발송된 결과는 계속 재조회합니다.</p>}
        <form action={requeryGithubIntegrationAction} className="space-y-2 border-t border-line pt-3">
          <HiddenFields row={row} csrfToken={csrfToken} expiresAt={admin.exp} />
          <label className="block text-[13px]">재조회 사유<input required name="reason" maxLength={1000} className="mt-1 block w-full rounded-lg border border-line p-2" /></label>
          <button type="submit" className="min-h-11 rounded-lg border border-line px-4 text-[14px]">GitHub 현재 상태 재조회</button>
        </form>
        {canRetransmit && <form action={retransmitGithubIntegrationAction} className="space-y-3 border-t border-line pt-3">
          <HiddenFields row={row} csrfToken={csrfToken} expiresAt={admin.exp} />
          <input type="hidden" name="expectedBindingRevision" value={row.currentBindingRevision ?? row.bindingRevision} /><input type="hidden" name="expectedPayloadHash" value={row.payloadHash} />
          <p className="text-[13px] leading-6">GitHub가 이전 요청을 처리했을 수 있어 재전송하면 중복 이슈가 생길 수 있습니다. GitHub 결과를 먼저 확인해 주세요. 같은 저장소와 현재 권한을 다시 확인한 뒤 한 번의 새 전송을 요청합니다.</p>
          <label className="flex gap-2 text-[13px]"><input type="checkbox" required name="duplicateRiskAcknowledged" value="yes" />중복 이슈 가능성을 확인했고 재전송을 요청합니다.</label>
          <label className="block text-[13px]">재전송 사유<input required name="reason" maxLength={1000} className="mt-1 block w-full rounded-lg border border-line p-2" /></label>
          <button type="submit" className="min-h-11 rounded-lg bg-accent-solid px-4 text-[14px] text-white">한 번 새로 전송 요청</button>
        </form>}
      </section>;
    })}
  </main>;
}
