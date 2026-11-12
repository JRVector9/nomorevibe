import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { aiConnections } from "@/lib/db/schema";
import { isWatchedAuditRow, readChangeWatch, type ChangeWatchSnapshot } from "@/lib/operations/change-watch";
import { buildLogLines, CONSOLE_LOG_RULES, logRawHref, type LogLine } from "@/lib/operations/console-log";
import { formatCount, formatKst } from "@/lib/operations/console-tasks";
import { actionLabel, targetLabel } from "../activity/labels";
import { activityFilter, activityLog } from "../activity/query";
import { LogAfter } from "./LogAfter";
import { PageStamp } from "../components/PageStamp";
import "./log.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "기록 — NoMoreVibe", robots: { index: false } };

type Props = { searchParams: Promise<{ q?: string; before?: string }> };

/**
 * 기록(메뉴 「기록」의 기본, 운영 콘솔 개편 조각 4b — 2026-11-12 최종 시안 「화면 6 기록」).
 * 바꾼 것이 한 줄씩: 때 · 한 일 · 누가 · 그 뒤 · 되돌리기. 줄은 작업 로그에서 만든다(lib/operations/console-log.ts) —
 * 접수 중단과 다시 열림은 한 줄로 합쳐 걸린 분을 적고, 같은 대상의 잇단 저장은 한 줄로. 「그 뒤」는 바꾼 것 지켜보기(조각 1c)의 판정과 처리량이다.
 * 읽기만 한다. 원시 줄은 「모두 보기」(/admin/activity)에서 그대로 보인다 — 작업 로그는 덧붙이기만 하고 고치거나 지울 수 없다.
 * 되돌리기는 이미 있는 곳으로만 보낸다(사람 확인 묶음째 되돌리기 · 그 설정 화면). 여기서 새로 쓰지 않는다.
 */
export default async function AdminLogPage({ searchParams }: Props) {
  if (!await currentAdmin()) redirect("/admin/login");
  const params = await searchParams;
  const filter = activityFilter({ q: params.q, before: params.before });
  const now = new Date().getTime();
  const [rows, connections] = await Promise.all([
    activityLog(filter, CONSOLE_LOG_RULES.pageRows),
    db.select({ id: aiConnections.id, label: aiConnections.label }).from(aiConnections).catch(() => []),
  ]);
  const { lines, hidden, oldestId } = buildLogLines(rows, { action: actionLabel, target: target => targetLabel(target).text,
    connectionLabels: new Map(connections.map(row => [row.id, row.label])) });
  // 바꾼 것 지켜보기 — 24시간 안의 지켜보는 줄이 이 쪽에 있을 때만 읽는다(웹들이 나눠 쓰는 캐시). 칸마다 기다린다(표를 막지 않는다)
  const watchRead = rows.some(row => isWatchedAuditRow(row, now)) ? readChangeWatch().catch(() => null) : null;
  const q = filter.q ?? null;
  const rawHref = q ? `/admin/activity?q=${encodeURIComponent(q)}` : "/admin/activity";
  const page = (before: number | null) => {
    const search = new URLSearchParams();
    if (q) search.set("q", q);
    if (before) search.set("before", String(before));
    return `/admin/log${search.size ? `?${search}` : ""}`;
  };
  const hiddenTotal = hidden.automatic + hidden.quiet;

  return <main className="lg-page pb-10 pt-6"><PageStamp />
    <div className="lg-head">
      <h1>기록</h1>
      <span className="lg-note">바꾼 것이 한 줄씩입니다. 접수 중단과 다시 열림은 한 줄로 합쳐 걸린 시간을 적고, 같은 대상을 잇달아 저장한 것도 한 줄입니다.</span>
      <Link className="text-button lg-raw" href={rawHref}>모두 보기 →</Link>
    </div>
    <Form action="/admin/log" className="lg-find" role="search">
      <label><span>찾기</span>
        <input type="search" name="q" defaultValue={q ?? ""} maxLength={100} placeholder="모델·단계·작업·사람·대상 이름" /></label>
      <button type="submit" className="button small primary">찾기</button>
      {q && <Link href="/admin/log" className="text-button">찾는 말 풀기</Link>}
    </Form>
    {q && <p className="lg-note">“{q}”이(가) 든 줄 — 대상·사람·작업 이름·내용에서 찾았습니다.</p>}

    {lines.length === 0 ? <p className="lg-empty">{q ? "그 말이 든 바꾼 것이 없습니다." : "바꾼 것이 없습니다."}{hiddenTotal ? ` 자동 처리·읽기 기록 ${formatCount(hiddenTotal)}줄은 「모두 보기」에 있습니다.` : ""}</p>
      : <div className="lg-scroll" role="region" aria-label="바꾼 것 표" tabIndex={0}>
        <table className="lg-table">
          <colgroup><col style={{ width: 112 }} /><col /><col style={{ width: 104 }} /><col style={{ width: "30%" }} /><col style={{ width: 112 }} /></colgroup>
          <thead><tr><th scope="col">때</th><th scope="col">한 일</th><th scope="col">누가</th><th scope="col">그 뒤</th><th scope="col"><span className="admin-vh">되돌리기</span></th></tr></thead>
          <tbody>{lines.map(line => <LogRow key={line.key} line={line} watchRead={watchRead} />)}</tbody>
        </table>
      </div>}

    <div className="lg-foot">
      <span>작업 로그 최근 {formatCount(CONSOLE_LOG_RULES.pageRows)}줄씩 묶습니다{hiddenTotal ? ` · 이 쪽의 자동 처리 ${formatCount(hidden.automatic)}줄 · 읽기·시험 ${formatCount(hidden.quiet)}줄은 「모두 보기」에만 있습니다` : ""}.</span>
      <span className="lg-pages">
        {filter.before && <Link className="text-button" href={page(null)}>처음으로</Link>}
        {rows.length === CONSOLE_LOG_RULES.pageRows && oldestId && <Link className="text-button" href={page(oldestId)}>더 오래된 것 →</Link>}
      </span>
    </div>
  </main>;
}

function LogRow({ line, watchRead }: { line: LogLine; watchRead: Promise<ChangeWatchSnapshot | null> | null }) {
  return <tr data-ok={line.ok ? undefined : "false"}>
    <td className="lg-when">{formatKst(line.at)}</td>
    <th scope="row">
      <span className="lg-title">{line.title}{line.count > 1 && <small> · {formatCount(line.count)}번</small>}</span>
      {!line.ok && <span className="lg-failed"><i aria-hidden="true" />실패{line.error ? ` · ${line.error}` : ""}</span>}
      <Link className="lg-rawline" prefetch={false} href={logRawHref(line)}>원래 줄</Link>
    </th>
    <td className="lg-who" title={line.actor}>{line.actor}</td>
    <td>{watchRead && line.ok
      ? <Suspense fallback={<span className="lg-none">세는 중…</span>}><LogAfter read={watchRead} ids={line.ids} /></Suspense>
      : <span className="lg-none">—</span>}</td>
    <td className="lg-act"><Undo line={line} /></td>
  </tr>;
}

/**
 * 되돌리기 — 이미 있는 곳으로만. 사람 확인 묶음은 일괄 결정 기록의 「묶음째 되돌리기」(확인 대화상자를 거친다),
 * 순위 저장은 이 저장 전·후 순위를 보이고 그 순위를 고치는 곳으로, 나머지 설정은 「최근 바뀐 설정」이 아는 그 설정 화면으로 보낸다.
 * 단추는 그 안내를 띄울 뿐(popover — 표의 옆 넘김에 잘리지 않게 화면 위에 뜬다) 여기서 바꾸지 않는다.
 */
function Undo({ line }: { line: LogLine }) {
  if (!line.ok || !line.undo) return null;
  if (!line.undo.href) return <span className="lg-none" title={line.undo.text}>되돌릴 수 없음</span>;
  const id = `undo-${line.key}`;
  return <>
    <button type="button" className="button small" popoverTarget={id}>되돌리기</button>
    <div id={id} popover="auto" className="lg-undo-pop" role="dialog" aria-label={`${line.title} 되돌리기`}>
      <h3>{line.title} 되돌리기</h3>
      {line.rankUndo && <ul className="lg-diff"><li><span>지금</span><span>{line.rankUndo.now}</span></li><li><span>되돌린 뒤</span><span>{line.rankUndo.back}</span></li></ul>}
      <p>{line.undo.text}</p>
      <p className="lg-none">되돌리기는 그 화면에서 저장 전 확인을 거쳐 합니다. 여기서는 바꾸지 않습니다.</p>
      <div className="lg-pop-acts"><Link className="button small primary" prefetch={false} href={line.undo.href}>되돌리러 가기 →</Link>
        <button type="button" className="button small" popoverTarget={id} popoverTargetAction="hide">닫기</button></div>
    </div>
  </>;
}
