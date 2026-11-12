import Link from "next/link";
import { Suspense } from "react";
import { formatAgo, formatDetailTime, formatListTime } from "@/lib/format/time";
import { logger } from "@/lib/observability/logger";
import { CHANGE_VERDICT_LABELS, CHANGE_VERDICT_TONES, CHANGE_WATCH_RULES, readChangeWatch, type ChangeWatchRow, type ChangeWatchSnapshot } from "@/lib/operations/change-watch";
import { ScrollTable } from "../components/ScrollTable";
import { StatusDot } from "../components/StatusDot";

/** 홈에 보이는 줄 수 — 넘으면 판정이 나쁜 줄을 먼저 남기고 나머지는 기록으로 보낸다 */
export const CHANGE_WATCH_HOME_ROWS = 8;
const HEADING_ID = "change-watch-h";

/**
 * 「바꾼 것 지켜보기」(운영 콘솔 개편 조각 1c) — 최근 24시간에 사람이 바꾼 설정마다 그 단계의 처리량을 바꾸기 전과 뒤로 견준 표.
 * 홈(/admin/flow)에 `<ChangeWatch />` 한 줄로 끼운다 — 스스로 읽고(lib/operations/change-watch readChangeWatch, 웹들이 나눠 쓰는 캐시),
 * 늦어도 둘레를 막지 않게 스스로 Suspense 를 친다. 쓰기는 없다 — 되돌리기는 기록 화면의 「되돌리러 가기」(그 설정 화면)로 간다.
 */
export function ChangeWatch({ fresh = false }: { fresh?: boolean }) {
  return (
    <Suspense fallback={<ChangeWatchFrame stamp={null}><p className="px-1 text-[13px] text-fg-3" aria-busy="true">바꾼 것을 세는 중…</p></ChangeWatchFrame>}>
      <ChangeWatchLoaded fresh={fresh} />
    </Suspense>
  );
}

async function ChangeWatchLoaded({ fresh }: { fresh: boolean }) {
  const watch = await readChangeWatch(fresh).catch((error: unknown) => {
    logger.warn("change_watch.unavailable", { errorName: error instanceof Error ? error.name : "unknown" });
    return null;
  });
  return <ChangeWatchTable watch={watch} now={new Date()} />;
}

function ChangeWatchFrame({ stamp, children }: { stamp: string | null; children: React.ReactNode }) {
  return (
    // 블록으로 둔다 — flex 세로 칸은 넓은 표(min-w 560px)의 폭을 따라 넓어져 좁은 화면에서 페이지가 옆으로 밀린다(표 안에서 가로 스크롤해야 한다)
    <section className="min-w-0 space-y-2" aria-labelledby={HEADING_ID} data-change-watch="">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 id={HEADING_ID} className="text-[15px] font-bold">바꾼 것 지켜보기</h2>
        <span className="text-[13px] text-fg-3">최근 {CHANGE_WATCH_RULES.windowHours}시간{stamp ? ` · ${stamp}` : ""}</span>
        <Link prefetch={false} href="/admin/activity" className="ml-auto text-[13px] text-accent hover:underline">기록 →</Link>
      </div>
      {children}
    </section>
  );
}

/** 홈에 남길 줄 — 판정이 나쁜 줄(다시 떨어짐·나빠짐)은 늘 남기고, 나머지는 최근 것부터 채운다. 보이는 순서는 때(최근 먼저) */
export function homeRows(rows: readonly ChangeWatchRow[], max = CHANGE_WATCH_HOME_ROWS): { shown: ChangeWatchRow[]; hidden: number } {
  if (rows.length <= max) return { shown: [...rows], hidden: 0 };
  const bad = rows.filter(row => row.verdict === "fell_back" || row.verdict === "worse");
  const keep = new Set(bad.slice(0, max));
  for (const row of rows) { if (keep.size >= max) break; keep.add(row); }
  return { shown: rows.filter(row => keep.has(row)), hidden: rows.length - keep.size };
}

/** 표 — 때 · 바꾼 것 · 전 → 후 · 판정. watch 가 null 이면 「읽지 못함」(0건이 아니다) */
export function ChangeWatchTable({ watch, now }: { watch: ChangeWatchSnapshot | null; now: Date }) {
  if (!watch) return (
    <ChangeWatchFrame stamp={null}>
      <p role="status" className="rounded-[12px] border border-line bg-bg-card px-4 py-5 text-[13px] text-fg-3">바꾼 것을 읽지 못했습니다 — 다음 새로 고침에서 다시 셉니다.</p>
    </ChangeWatchFrame>
  );
  const stamp = `${formatAgo(watch.measuredAt, now)} 셈`;
  if (!watch.rows.length) return (
    <ChangeWatchFrame stamp={stamp}>
      <p className="rounded-[12px] border border-line bg-bg-card px-4 py-5 text-center text-[13px] text-fg-3">최근 {watch.windowHours}시간에 바꾼 것이 없습니다</p>
    </ChangeWatchFrame>
  );
  const { shown, hidden } = homeRows(watch.rows);
  return (
    <ChangeWatchFrame stamp={stamp}>
      {/* relative — 상태 점의 숨은 글자(.admin-vh, absolute)가 가로 스크롤 칸 밖으로 페이지 폭을 늘리지 않게 */}
      <div className="relative overflow-hidden rounded-[12px] border border-line bg-bg-card">
        <ScrollTable label="바꾼 것 지켜보기">
          <table className="w-full min-w-[560px] table-fixed text-left text-[13px]">
            <colgroup><col className="w-[128px]" /><col /><col className="w-[38%]" /><col className="w-[124px]" /></colgroup>
            <thead className="border-b border-line bg-bg-soft text-fg-3">
              <tr><th className="px-3 py-2 font-semibold">때</th><th className="px-3 py-2 font-semibold">바꾼 것</th>
                <th className="px-3 py-2 font-semibold">전 → 후</th><th className="px-3 py-2 font-semibold">판정</th></tr>
            </thead>
            <tbody>
              {shown.map(row => {
                const flow = row.beforeText ? `${row.beforeText} → ${row.afterText}` : row.afterText;
                const why = [row.reason, ...row.notes].filter(Boolean).join(" · ");
                return (
                  <tr key={row.key} className="border-b border-line align-top last:border-0" data-verdict={row.verdict}>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-fg-2" title={formatDetailTime(row.at)}>{formatListTime(row.at, now)}</td>
                    {/* 관리자 표의 몸 칸은 td 다(.admin-prototype th 는 머리 줄 모양이라 몸에 쓰면 회색 머리처럼 보인다) */}
                    <td className="px-3 py-2">
                      <span className="block truncate font-semibold" title={row.title}>{row.title}</span>
                      <span className="block truncate text-fg-3">{row.stage ? `${row.stage} · ` : ""}{row.actor}</span>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-fg-2">
                      <span className="block" title={flow}>{flow}</span>
                      {row.notes.map(note => <span key={note} className="block text-fg-3">{note}</span>)}
                    </td>
                    <td className="px-3 py-2"><StatusDot state={CHANGE_VERDICT_TONES[row.verdict]} label={CHANGE_VERDICT_LABELS[row.verdict]} title={why || undefined} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollTable>
      </div>
      <p className="px-1 text-[13px] text-fg-3">
        바꾸기 전 {CHANGE_WATCH_RULES.beforeHours}시간의 시간당 평균과 바꾼 뒤 첫 1시간·지금 최근 1시간의 처리 건수(모델 호출 장부의 끝난 호출)를 견줍니다.
        {hidden > 0 && <> 그 밖에 {hidden.toLocaleString("ko-KR")}건은 <Link prefetch={false} href="/admin/activity" className="text-accent hover:underline">기록</Link>에 있습니다.</>}
      </p>
    </ChangeWatchFrame>
  );
}
