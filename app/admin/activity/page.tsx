import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { ADMIN_LOG_PAGE_SIZE, adminLog, adminLogFacets, type AdminLogRow } from "@/lib/operations/admin-log";
import { ACTION_GROUPS, actionLabel, type ActionGroup } from "./labels";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "작업 로그 — NoMoreVibe", robots: { index: false } };

type Props = { searchParams: Promise<{ group?: string; actor?: string; failed?: string; before?: string }> };

const time = (value: Date) => value.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "medium" });
const count = (value: number) => value.toLocaleString("ko-KR");
const KIND: Record<string, string> = { github: "GitHub", local: "로컬 로그인", token: "API 토큰" };

/** 값 하나를 한 줄로 — 길면 자른다 */
function brief(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "없음";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** 내용 요약 — 설정은 바뀐 경로만, 나머지는 값이 있는 항목만 */
function summary(row: AdminLogRow): string[] {
  const detail = row.detail ?? {};
  if (Array.isArray(detail.changes)) {
    const changes = detail.changes as { path: string; before: unknown; after: unknown }[];
    if (!changes.length) return ["바뀐 값 없음"];
    const lines = changes.slice(0, 4).map((change) => `${change.path}: ${brief(change.before)} → ${brief(change.after)}`);
    return changes.length > 4 ? [...lines, `외 ${changes.length - 4}개`] : lines;
  }
  return Object.entries(detail).filter(([, value]) => value !== null && value !== "" && value !== undefined)
    .slice(0, 5).map(([key, value]) => `${key}: ${brief(value)}`);
}

/**
 * 관리자 작업 로그 — 누가 어디서 무엇을 바꿨는지. 읽기만 한다: 이 화면에도, 앱 어디에도 지우는 수단이 없고
 * DB 가 고치기·지우기를 거부한다.
 */
export default async function AdminActivityPage({ searchParams }: Props) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const params = await searchParams;
  const group = params.group && Object.hasOwn(ACTION_GROUPS, params.group) ? params.group as ActionGroup : null;
  const actor = params.actor?.slice(0, 120) || undefined;
  const failedOnly = params.failed === "1";
  const parsedBefore = Number(params.before);
  const before = Number.isSafeInteger(parsedBefore) && parsedBefore > 0 ? parsedBefore : undefined;

  const [rows, facets] = await Promise.all([
    adminLog({ actions: group ? [...ACTION_GROUPS[group].actions] : undefined, actor, failedOnly, before }),
    adminLogFacets(),
  ]);
  const href = (next: { group?: ActionGroup | null; actor?: string | null; failed?: boolean; before?: number }) => {
    const query = new URLSearchParams();
    const g = next.group === undefined ? group : next.group;
    const a = next.actor === undefined ? actor : next.actor;
    const f = next.failed ?? failedOnly;
    if (g) query.set("group", g);
    if (a) query.set("actor", a);
    if (f) query.set("failed", "1");
    if (next.before) query.set("before", String(next.before));
    return `/admin/activity${query.size ? `?${query}` : ""}`;
  };
  const actionCount = new Map(facets.actions.map((row) => [row.action, row.count]));
  const groupCount = (name: ActionGroup) => ACTION_GROUPS[name].actions.reduce((sum, action) => sum + (actionCount.get(action) ?? 0), 0);
  const total = facets.actions.reduce((sum, row) => sum + row.count, 0);
  const chip = (active: boolean) => `rounded-full border px-2.5 py-1 text-[13px] ${active
    ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line bg-bg-card text-fg-2 hover:bg-bg-hover"}`;

  return (
    <main className="flex flex-col gap-3 pb-10 pt-6">
      <div className="flex flex-wrap items-baseline gap-3 border-b border-line pb-3">
        <h1 className="text-[22px] font-extrabold tracking-tight">작업 로그</h1>
        <span className="text-[13px] text-fg-3">관리자가 바꾼 것 전부 — 덧붙이기만 하고 고치거나 지울 수 없습니다 · 전체 {count(total)}건</span>
      </div>

      <div className="flex flex-wrap items-center gap-2" aria-label="거르기">
        <Link className={chip(!group)} href={href({ group: null })} aria-current={!group ? "page" : undefined}>전체</Link>
        {(Object.keys(ACTION_GROUPS) as ActionGroup[]).map((name) => (
          <Link key={name} className={chip(group === name)} href={href({ group: name })} aria-current={group === name ? "page" : undefined}>
            {ACTION_GROUPS[name].label} <span className="font-mono">{count(groupCount(name))}</span>
          </Link>
        ))}
        <Link className={chip(failedOnly)} href={href({ failed: !failedOnly })}>실패만</Link>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        {facets.actors.slice(0, 8).map((row) => (
          <Link key={row.actor} className={chip(actor === row.actor)} href={href({ actor: actor === row.actor ? null : row.actor })}>
            {row.actor} <span className="font-mono">{count(row.count)}</span>
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">남은 작업이 없습니다.</p>
      ) : (
        <div className="overflow-x-auto rounded-[12px] border border-line bg-bg-card">
          <table className="w-full min-w-[880px] text-left text-[13px]">
            <thead className="border-b border-line text-fg-3">
              <tr><th className="px-3 py-2 font-semibold">시각</th><th className="px-3 py-2 font-semibold">처리자</th>
                <th className="px-3 py-2 font-semibold">작업</th><th className="px-3 py-2 font-semibold">대상</th>
                <th className="px-3 py-2 font-semibold">결과</th><th className="px-3 py-2 font-semibold">내용</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line align-top last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-fg-2">{time(row.createdAt)}</td>
                  <td className="px-3 py-2">
                    <b className="font-semibold">{row.actor}</b>
                    <span className="block text-fg-3">{row.actorKind ? KIND[row.actorKind] ?? row.actorKind : "스크립트·이전 기록"}
                      {row.ip && <span className="font-mono"> · {row.ip}</span>}</span>
                    {row.userAgent && <span className="block max-w-[220px] truncate text-fg-3" title={row.userAgent}>{row.userAgent}</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{actionLabel(row.action)}<span className="block font-mono text-fg-3">{row.action}</span></td>
                  <td className="max-w-[220px] break-all px-3 py-2 font-mono text-fg-2">{row.target}</td>
                  <td className="whitespace-nowrap px-3 py-2">{row.ok
                    ? <span className="font-semibold text-up">성공</span>
                    : <span className="font-semibold text-down" title={row.error ?? undefined}>실패</span>}
                    {!row.ok && row.error && <span className="block max-w-[200px] whitespace-normal text-fg-3">{row.error}</span>}</td>
                  <td className="max-w-[360px] px-3 py-2 text-fg-2">
                    {summary(row).map((line, index) => <span key={index} className="block break-all">{line}</span>)}
                    {Object.keys(row.detail ?? {}).length > 0 && (
                      <details className="mt-1 text-fg-3"><summary className="cursor-pointer">전체 보기</summary>
                        <pre className="mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap break-all rounded bg-bg-soft p-2 font-mono text-[13px]">
                          {JSON.stringify(row.detail, null, 2)}</pre></details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between text-[13px] text-fg-3">
        <span>최근 것부터 {count(ADMIN_LOG_PAGE_SIZE)}건씩</span>
        <span className="flex gap-3">
          {before && <Link className="text-accent hover:underline" href={href({})}>처음으로</Link>}
          {rows.length === ADMIN_LOG_PAGE_SIZE && <Link className="text-accent hover:underline" href={href({ before: rows.at(-1)!.id })}>더 오래된 것 →</Link>}
        </span>
      </div>
    </main>
  );
}
