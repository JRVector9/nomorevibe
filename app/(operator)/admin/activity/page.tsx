import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { redirect } from "next/navigation";
import { adminLocalLoginEnabled, currentAdmin, localOperatorName, OPERATOR_NAME_MAX } from "@/lib/auth/admin";
import { formatDetailTime, formatListTime } from "@/lib/format/time";
import { ADMIN_LOG_PAGE_SIZE, adminLogFacets } from "@/lib/operations/admin-log";
import { AdminIcon } from "../components/AdminIcon";
import { ScrollTable } from "../components/ScrollTable";
import { ACTION_GROUPS, actionLabel, targetLabel, type ActionGroup } from "./labels";
import { OperatorName } from "./OperatorName";
import { activityFilter, activityLog } from "./query";
import { isScriptRow, summaryLine, summaryLines } from "./summary";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "작업 로그 — NoMoreVibe", robots: { index: false } };

type Props = { searchParams: Promise<{ group?: string; actor?: string; failed?: string; before?: string; target?: string }> };

const count = (value: number) => value.toLocaleString("ko-KR");
const KIND: Record<string, string> = { github: "GitHub", local: "로컬 로그인", token: "API 토큰" };

/**
 * 관리자 작업 로그 — 누가 어디서 무엇을 바꿨는지. 읽기만 한다: 이 화면에도, 앱 어디에도 지우는 수단이 없고
 * DB 가 고치기·지우기를 거부한다.
 *
 * 줄마다 한 줄 요약이고 펼쳐서 전체를 본다. 브라우저 정보(UA)는 아이콘에 접어 둔다. 대상(?target=slug 또는 owner/repo)으로
 * 한 제품의 기록만 볼 수 있다 — 제품 상세가 이 주소로 잇는다.
 */
export default async function AdminActivityPage({ searchParams }: Props) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const filter = activityFilter(await searchParams);
  const { group, actor, failedOnly, before, target } = filter;

  const local = adminLocalLoginEnabled();
  const now = new Date();
  const [rows, facets, operator] = await Promise.all([
    activityLog(filter),
    adminLogFacets(),
    local ? localOperatorName() : Promise.resolve(null),
  ]);
  const query = (next: { group?: ActionGroup | null; actor?: string | null; failed?: boolean; before?: number; target?: string | null }) => {
    const search = new URLSearchParams();
    const g = next.group === undefined ? group : next.group;
    const a = next.actor === undefined ? actor : next.actor;
    const f = next.failed ?? failedOnly;
    const t = next.target === undefined ? target : next.target;
    if (g) search.set("group", g);
    if (a) search.set("actor", a);
    if (f) search.set("failed", "1");
    if (t) search.set("target", t);
    if (next.before) search.set("before", String(next.before));
    return search;
  };
  const href = (next: Parameters<typeof query>[0]) => {
    const search = query(next);
    return `/admin/activity${search.size ? `?${search}` : ""}`;
  };
  const actionCount = new Map(facets.actions.map((row) => [row.action, row.count]));
  const groupCount = (name: ActionGroup) => ACTION_GROUPS[name].actions.reduce((sum, action) => sum + (actionCount.get(action) ?? 0), 0);
  const total = facets.actions.reduce((sum, row) => sum + row.count, 0);
  const chip = (active: boolean) => `rounded-full border px-2.5 py-1 text-[13px] ${active
    ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line bg-bg-card text-fg-2 hover:bg-bg-hover"}`;

  return (
    <main className="flex min-w-0 flex-col gap-3 pb-10 pt-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-3">
        <h1 className="text-[22px] font-extrabold tracking-tight">작업 로그</h1>
        <span className="text-[13px] text-fg-3">관리자가 바꾼 것 전부 — 덧붙이기만 하고 고치거나 지울 수 없습니다 · 전체 {count(total)}건</span>
        <a href={`/admin/export?view=activity&format=csv${query({}).size ? `&${query({})}` : ""}`}
          className="ml-auto text-[13px] text-accent hover:underline">CSV 내보내기</a>
      </div>

      {local && <OperatorName current={operator} max={OPERATOR_NAME_MAX} />}

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

      {/* 대상으로 찾기 — 제품 slug 나 owner/repo(GitHub 주소도 된다). 다른 거르기는 그대로 둔다 */}
      <Form action="/admin/activity" className="flex flex-wrap items-center gap-2 text-[13px]">
        {group && <input type="hidden" name="group" value={group} />}
        {actor && <input type="hidden" name="actor" value={actor} />}
        {failedOnly && <input type="hidden" name="failed" value="1" />}
        <label className="flex min-w-0 flex-1 basis-[260px] items-center gap-2">
          <span className="shrink-0 font-semibold text-fg-2">대상</span>
          <input type="search" name="target" defaultValue={target ?? ""} maxLength={200} placeholder="제품 slug · owner/repo · GitHub 주소"
            className="min-w-0 flex-1 rounded-lg border border-line bg-bg-card px-2.5 py-1.5 text-[13px] text-fg" />
        </label>
        <button type="submit" className="admin-button" data-tone="primary">찾기</button>
        {target && <Link href={href({ target: null })} className="px-1 py-1.5 text-fg-2 underline">대상 거르기 풀기</Link>}
      </Form>
      {target && <p className="text-[13px] text-fg-3">
        <b className="font-mono text-fg-2">{target}</b>의 기록 — 대상이 정확히 같은 줄, 이어진 제품·저장소의 줄, 이 대상을 담은 일괄 스크립트 줄입니다.
      </p>}

      {rows.length === 0 ? (
        <p className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">남은 작업이 없습니다.</p>
      ) : (
        <div className="overflow-hidden rounded-[12px] border border-line bg-bg-card">
          <ScrollTable label="작업 로그">
            <table className="w-full min-w-[860px] table-fixed text-left text-[13px]">
              <colgroup><col className="w-[124px]" /><col className="w-[168px]" /><col className="w-[184px]" /><col className="w-[172px]" />
                <col className="w-[72px]" /><col /></colgroup>
              <thead className="border-b border-line bg-bg-soft text-fg-3">
                <tr><th className="px-3 py-2 font-semibold">시각</th><th className="px-3 py-2 font-semibold">처리자</th>
                  <th className="px-3 py-2 font-semibold">작업</th><th className="px-3 py-2 font-semibold">대상</th>
                  <th className="px-3 py-2 font-semibold">결과</th><th className="px-3 py-2 font-semibold">내용</th></tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const script = isScriptRow(row);
                  const shown = targetLabel(row.target);
                  const lines = summaryLines(row);
                  const origin = [row.ip, row.userAgent].filter(Boolean).join(" · ");
                  return (
                    <tr key={row.id} className="border-b border-line align-top last:border-0">
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-fg-2" title={formatDetailTime(row.createdAt)}>{formatListTime(row.createdAt, now)}</td>
                      <td className="px-3 py-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <b className="truncate font-semibold" title={row.actor}>{row.actor}</b>
                          {script && <span className="shrink-0 rounded bg-bg-soft px-1.5 text-[13px] font-semibold text-fg-2">스크립트</span>}
                          {origin && <span className="shrink-0 text-fg-3" title={origin} aria-label={`접속 정보: ${origin}`} role="img">
                            <AdminIcon name="monitor" size={15} /></span>}
                        </span>
                        <span className="block truncate text-fg-3">{row.actorKind ? KIND[row.actorKind] ?? row.actorKind : "스크립트·이전 기록"}</span>
                      </td>
                      <td className="px-3 py-2"><span className="block truncate" title={row.action}>{actionLabel(row.action)}</span></td>
                      <td className="px-3 py-2">{shown.entity
                        ? <Link href={href({ target: row.target })} className="block truncate font-mono text-fg-2 hover:text-accent" title={`${row.target}의 기록만 보기`}>{shown.text}</Link>
                        : <span className="block truncate text-fg-2" title={row.target}>{shown.text}</span>}</td>
                      <td className="px-3 py-2">{row.ok
                        ? <span className="font-semibold text-up">성공</span>
                        : <span className="font-semibold text-down" title={row.error ?? undefined}>실패</span>}
                        {!row.ok && row.error && <span className="block truncate text-fg-3" title={row.error}>{row.error}</span>}</td>
                      <td className="px-3 py-2 text-fg-2">
                        {lines.length > 0 || origin ? (
                          <details className="group">
                            <summary className="cursor-pointer truncate marker:text-fg-3">{summaryLine(row)}</summary>
                            <div className="mt-1 flex flex-col gap-0.5">
                              {lines.map((line, index) => <span key={index} className="break-all">{line}</span>)}
                              {origin && <span className="break-all text-fg-3">접속: {origin}</span>}
                              <pre className="mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap break-all rounded bg-bg-soft p-2 font-mono text-[13px] text-fg-3">
                                {JSON.stringify(row.detail, null, 2)}</pre>
                            </div>
                          </details>
                        ) : <span className="text-fg-3">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollTable>
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
