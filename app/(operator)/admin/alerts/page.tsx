import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { listJobStates } from "@/lib/jobs/runner";
import { isPausedJob } from "@/lib/jobs/status";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { CONSOLE_ALERT_RULES, quietHours } from "@/lib/operations/console-alerts";
import { readConsoleAlertSettings, readConsoleAlertsView, type ConsoleAlertView } from "@/lib/operations/console-alerts-store";
import { formatCount, formatKst } from "@/lib/operations/console-tasks";
import { PageStamp } from "../components/PageStamp";
import { jobControlCsrf } from "../status/job-control-csrf";
import { AlertSettingsForm } from "./AlertSettingsForm";
import "./alerts.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "알림 — NoMoreVibe", robots: { index: false } };

const CLOSE_TEXT: Record<string, string> = { resolved: "해소", kept: "그대로 둠", disabled: "알림 끔" };
const ALERT_JOB = "console-alerts";

/** 줄의 지금 — 점 하나 + 짧은 말 */
function alertState(row: ConsoleAlertView, quiet: boolean): { tone: "ok" | "warn" | "off"; text: string } {
  if (row.closedAt) return { tone: "off", text: `닫힘 · ${CLOSE_TEXT[row.closeReason ?? ""] ?? row.closeReason ?? "—"}` };
  if (row.releasedAt) return { tone: "ok", text: row.missingSince ? "보냄 · 사라지는 중" : "보냄" };
  return { tone: "warn", text: quiet ? "조용한 시간이라 기다림" : "다음 작업에서 보냄" };
}

/**
 * 홈 › 알림(운영 콘솔 개편 조각 4b, 시안 흐름 7 「자리에 없을 때」) — 휴대폰 알림을 켜고 끄고, 조용한 시간을 정하고, 보낸 알림을 본다.
 * 보내는 것: 홈 할 일 중 멈춤 · 평소와 다름이 새로 생겼을 때 한 번(그 할 일의 제목 · 사실 한 줄 · 그 할 일로 가는 주소). 해소됐다가 다시 생기면 다시 보낸다.
 * 「그대로 둔다」로 표시한 할 일과 접수 중단 30분 전의 접힌 줄은 보내지 않는다. 보내는 주체는 maintenance 작업(console-alerts, 5분)이고,
 * 실제 전송은 장애 알림과 같은 통로(감시 → 복구 게이트웨이 → Oracle watchdog Telegram)다. 이 화면은 설정 저장(작업 로그 한 줄)만 쓴다.
 */
export default async function AdminAlertsPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const readOnly = adminWorkspaceReadOnly();
  const secret = authSecret();
  const [current, rows, jobs] = await Promise.all([
    readConsoleAlertSettings().catch(() => null),
    readConsoleAlertsView(50).catch(() => null),
    listJobStates().catch(() => null),
  ]);
  const now = new Date().getTime();
  const job = jobs?.find(row => row.name === ALERT_JOB) ?? null;
  const quiet = current ? quietHours(current.settings, now) : { quiet: false, endsAt: null };
  const open = rows?.filter(row => !row.closedAt) ?? [];
  const csrf = secret && !readOnly ? { token: jobControlCsrf(admin, secret), expiresAt: admin.exp } : null;

  return <main className="al-page pb-10 pt-6"><PageStamp />
    <div className="al-head">
      <h1>알림</h1>
      <span className="al-note">멈춤과 평소와 다름이 새로 생기면 휴대폰으로 한 번 알립니다. 해소됐다가 다시 생기면 다시 보냅니다. 「그대로 둔다」로 표시한 할 일은 보내지 않습니다.</span>
    </div>

    <p className="al-strip" aria-label="지금 상태">
      <span>알림<b>{!current ? "셀 수 없음" : current.settings.enabled ? "켜짐" : "꺼짐"}</b></span>
      <span>조용한 시간<b>{current?.settings.quietStart && current.settings.quietEnd ? `${current.settings.quietStart} ~ ${current.settings.quietEnd}${quiet.quiet ? " · 지금" : ""}` : "없음"}</b></span>
      <span>열린 알림<b>{rows ? formatCount(open.length) : "셀 수 없음"}</b></span>
      <span>알림 작업<b>{!jobs ? "셀 수 없음" : !job ? "아직 돈 적 없음" : isPausedJob(job, now) ? "사람이 멈춤"
        : job.lastRunAt ? `${formatKst(job.lastRunAt.toISOString())}${job.lastError ? " · 오류" : ""}` : "아직 돈 적 없음"}</b></span>
      {current?.at && <span>마지막 저장<b>{formatKst(current.at)} · {current.actor}</b></span>}
    </p>

    <div className="al-grid">
      <section className="al-card" aria-labelledby="al-settings-title">
        <h2 id="al-settings-title">설정</h2>
        {current ? <AlertSettingsForm settings={current.settings} basedOn={current.at} csrf={csrf} readOnly={readOnly} />
          : <p className="al-muted">설정을 읽지 못했습니다 — 새로고침해 주세요.</p>}
      </section>
      <section className="al-card" aria-labelledby="al-route-title">
        <h2 id="al-route-title">보내는 길</h2>
        <ol className="al-route">
          <li><b>세기</b> maintenance 작업 「운영 홈 휴대폰 알림」(console-alerts)이 5분마다 홈과 같은 규칙으로 할 일을 셉니다.</li>
          <li><b>내보내기</b> 새로 생긴 멈춤 · 평소와 다름을 알림 줄로 열고, 감시(monitor)가 그 줄을 건강 파일에 적습니다.</li>
          <li><b>보내기</b> Oracle 감시자(watchdog)가 복구 게이트웨이로 읽어 장애 알림과 같은 Telegram 대화방에 줄마다 한 번 보냅니다.</li>
        </ol>
        <p className="al-muted">사라진 할 일은 {Math.round(CONSOLE_ALERT_RULES.closeAfterMissingMs / 60_000)}분 넘게 돌아오지 않으면 닫힙니다. 한 번에 {CONSOLE_ALERT_RULES.maxRelay}건까지 넘깁니다.
          Oracle 쪽 설치가 끝나기 전에는 줄이 열려도 휴대폰에 오지 않습니다.</p>
        <p className="al-links"><Link prefetch={false} className="text-button" href="/admin/flow">홈 할 일 →</Link>
          <Link prefetch={false} className="text-button" href={`/admin/status?tab=jobs&job=${ALERT_JOB}`}>알림 작업 →</Link>
          <Link prefetch={false} className="text-button" href={`/admin/log?q=${encodeURIComponent("휴대폰 알림 설정")}`}>설정 기록 →</Link></p>
      </section>
    </div>

    <section aria-labelledby="al-list-title" className="al-list">
      <div className="al-list-head"><h2 id="al-list-title">알림 줄</h2><span className="al-note">최근 50줄 · 닫힌 줄은 {CONSOLE_ALERT_RULES.retentionDays}일 뒤 지웁니다</span></div>
      {!rows ? <p className="al-empty">알림 줄을 읽지 못했습니다(마이그레이션 0183 전이거나 DB 읽기 실패).</p>
        : rows.length === 0 ? <p className="al-empty">아직 알림 줄이 없습니다.</p>
        : <div className="al-scroll" role="region" aria-label="알림 줄 표" tabIndex={0}>
          <table className="al-table">
            <colgroup><col style={{ width: 112 }} /><col /><col style={{ width: 168 }} /><col style={{ width: 112 }} /></colgroup>
            <thead><tr><th scope="col">생긴 때</th><th scope="col">할 일</th><th scope="col">지금</th><th scope="col">닫힌 때</th></tr></thead>
            <tbody>{rows.map(row => {
              const state = alertState(row, quiet.quiet);
              return <tr key={row.id}>
                <td className="al-when">{formatKst(row.openedAt)}</td>
                <th scope="row"><span className="al-title">{row.title}</span><span className="al-fact">{row.fact}</span></th>
                <td><span className="al-st" data-tone={state.tone}><i aria-hidden="true" />{state.text}</span>
                  {row.releasedAt && <span className="al-fact">{formatKst(row.releasedAt)} 내보냄</span>}</td>
                <td className="al-when">{row.closedAt ? formatKst(row.closedAt) : "—"}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>}
    </section>
  </main>;
}
