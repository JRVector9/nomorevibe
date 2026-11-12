import Link from "next/link";
import { Suspense } from "react";
import { formatAgo, formatDetailTime, formatListTime } from "@/lib/format/time";
import { logger } from "@/lib/observability/logger";
import { formatKst } from "@/lib/operations/console-tasks";
import { CHANGE_VERDICT_LABELS, CHANGE_VERDICT_TONES, CHANGE_WATCH_RULES, readChangeWatch, type ChangeWatchRow, type ChangeWatchSnapshot } from "@/lib/operations/change-watch";
import "./console-home.css";

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
    <Suspense fallback={<ChangeWatchFrame stamp={null}><p className="ch-note" aria-busy="true">바꾼 것을 세는 중…</p></ChangeWatchFrame>}>
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
    // 블록으로 둔다 — flex 세로 칸은 넓은 표의 폭을 따라 넓어져 좁은 화면에서 페이지가 옆으로 밀린다(표 안에서 가로 스크롤해야 한다)
    <section className="ch-watch" aria-labelledby={HEADING_ID} data-change-watch="">
      <div className="ch-head">
        <h2 id={HEADING_ID}>바꾼 것 지켜보기</h2>
        <span className="ch-count">최근 {CHANGE_WATCH_RULES.windowHours}시간{stamp ? ` · ${stamp}` : ""}</span>
        <Link prefetch={false} href="/admin/activity" className="text-button ch-more">기록 →</Link>
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

/** 판정의 점 색 — 흐름 표와 같은 점 하나 + 짧은 말(시안 .st) */
const VERDICT_TONE = { ok: "ok", delayed: "warn", failed: "bad", idle: "off" } as const;

/**
 * 표 — 때 · 바꾼 것 · 바꾸기 전 · 바꾼 뒤 · 판정(2026-11-12 「1인 운영 콘솔 시안」 화면 1, 열 폭 112 · 나머지 · 220 · 220 · 132).
 * 할 일·흐름 아래 전체 폭에 놓인다. watch 가 null 이면 「읽지 못함」(0건이 아니다)
 */
export function ChangeWatchTable({ watch, now }: { watch: ChangeWatchSnapshot | null; now: Date }) {
  if (!watch) return (
    <ChangeWatchFrame stamp={null}>
      <p role="status" className="ch-empty">바꾼 것을 읽지 못했습니다 — 다음 새로 고침에서 다시 셉니다.</p>
    </ChangeWatchFrame>
  );
  const stamp = `${formatAgo(watch.measuredAt, now)} 셈`;
  if (!watch.rows.length) return (
    <ChangeWatchFrame stamp={stamp}>
      <p className="ch-empty">최근 {watch.windowHours}시간에 바꾼 것이 없습니다</p>
    </ChangeWatchFrame>
  );
  const { shown, hidden } = homeRows(watch.rows);
  return (
    <ChangeWatchFrame stamp={stamp}>
      <div className="ch-scroll" role="region" aria-label="바꾼 것 지켜보기" tabIndex={0}>
        <table className="ch-table ch-watch-table">
          <colgroup><col style={{ width: 112 }} /><col /><col style={{ width: 220 }} /><col style={{ width: 220 }} /><col style={{ width: 132 }} /></colgroup>
          <thead>
            <tr><th scope="col">때</th><th scope="col">바꾼 것</th><th scope="col">바꾸기 전</th><th scope="col">바꾼 뒤</th><th scope="col">판정</th></tr>
          </thead>
          <tbody>
            {shown.map(row => {
              const why = [row.reason, ...row.notes].filter(Boolean).join(" · ");
              return (
                <tr key={row.key} data-verdict={row.verdict}>
                  {/* 시안처럼 「11-12 07:10」 한 줄(KST) — 지난 시간은 마우스를 올린 말에 */}
                  <td className="n ch-when" title={`${formatDetailTime(row.at)} · ${formatListTime(row.at, now)}`}>{formatKst(row.at)}</td>
                  <th scope="row">
                    <span className="ch-what">{row.title}</span>
                    <span className="ch-sub">{row.stage ? `${row.stage} · ` : ""}{row.actor}</span>
                  </th>
                  <td className="q">{row.beforeText ?? "—"}</td>
                  <td>
                    <span className="ch-after">{row.afterText}</span>
                    {row.notes.map(note => <span key={note} className="ch-sub">{note}</span>)}
                  </td>
                  <td><span className="ch-st" data-tone={VERDICT_TONE[CHANGE_VERDICT_TONES[row.verdict]]} data-state={CHANGE_VERDICT_TONES[row.verdict]}
                    title={why || undefined}><i aria-hidden="true" />{CHANGE_VERDICT_LABELS[row.verdict]}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="ch-note">
        바꾸기 전 {CHANGE_WATCH_RULES.beforeHours}시간의 시간당 평균과 바꾼 뒤 첫 1시간·지금 최근 1시간의 처리 건수(모델 호출 장부의 끝난 호출)를 견줍니다.
        {hidden > 0 && <> 그 밖에 {hidden.toLocaleString("ko-KR")}건은 <Link prefetch={false} href="/admin/activity">기록</Link>에 있습니다.</>}
      </p>
    </ChangeWatchFrame>
  );
}
