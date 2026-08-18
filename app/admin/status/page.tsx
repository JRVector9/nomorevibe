import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { frontierCounts, candidateCounts, rejectionBreakdown, yieldBySignal } from "@/lib/crawl/repository";
import { getSettings } from "@/lib/crawl/settings";
import { listJobStates } from "@/lib/jobs/runner";
import { downProducts, DOWN_THRESHOLD } from "@/lib/domain/products/health";
import { topClickedSince } from "@/lib/domain/products/clicks";
import { JOB_NAMES } from "@/lib/jobs/registry";
import { getCurrentSeason, RANKING_STALE_MS } from "@/lib/domain/ranking/view";
import { Panel } from "@/components/Panel";
import { AdminNav } from "../AdminNav";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "수집 현황 — NoMoreVibe", robots: { index: false } };

/** 사유 코드를 사람 말로. 코드 그대로 두면 무엇이 얼마나 거르는지 읽는 데 시간이 걸린다 */
const REASON_LABELS: Record<string, string> = {
  no_homepage: "배포 URL 없음",
  unreachable: "배포 URL 접속 불가",
  not_a_product: "배포물이 아님",
  large_oss: "대형 오픈소스·조직",
  personal_site: "개인 사이트·블로그",
  fork: "포크",
  already_listed: "이미 등록됨",
  banned: "차단된 URL",
  ambiguous: "규칙으로 못 가름",
  passed: "통과",
};

const STATE_LABELS: Record<string, string> = {
  pending: "조사 대기",
  fetching: "가져오는 중",
  done: "확보 완료",
  failed: "실패",
  skipped: "건너뜀",
  new: "판정 대기",
  approved: "발행 대기",
  rejected: "거부",
  needs_review: "심사 대기",
  published: "발행됨",
};

function when(at: Date | null): string {
  if (!at) return "없음";
  const minutes = Math.round((Date.now() - at.getTime()) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}시간 전` : `${Math.round(hours / 24)}일 전`;
}

function rankingSnapshotIsStale(at: Date | null): boolean {
  return !at || Date.now() - at.getTime() > RANKING_STALE_MS;
}

function Counts({ counts, empty }: { counts: Record<string, number>; empty: string }) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return <p className="text-[13px] text-fg-3">{empty}</p>;
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2">
      {rows.map(([key, count]) => (
        <div key={key} className="flex items-baseline gap-2">
          <dt className="text-[12.5px] text-fg-2">{STATE_LABELS[key] ?? key}</dt>
          <dd className="font-mono text-[14px] font-bold">{count.toLocaleString("ko-KR")}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function StatusPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const [settings, frontier, candidates, rejections, jobStates, signalRows, rankingSeason] = await Promise.all([
    getSettings(),
    frontierCounts(),
    candidateCounts(),
    rejectionBreakdown(),
    listJobStates(),
    yieldBySignal(),
    getCurrentSeason(),
  ]);
  const [down, topClicked] = await Promise.all([downProducts(), topClickedSince(30)]);

  const states = new Map(jobStates.map((job) => [job.name, job]));
  const rejectedTotal = rejections.reduce((sum, r) => sum + r.count, 0);
  const rankingStale = rankingSnapshotIsStale(rankingSeason?.refreshedAt ?? null);

  /** 신호별로 조사한 수와 그중 목록에 오른 수 */
  const signals = new Map<string, { judged: number; kept: number }>();
  for (const row of signalRows) {
    const entry = signals.get(row.signal) ?? { judged: 0, kept: 0 };
    entry.judged += row.count;
    if (row.state === "approved" || row.state === "published") entry.kept += row.count;
    signals.set(row.signal, entry);
  }

  return (
    <main className="mx-auto max-w-[900px] px-6 pb-20">
      <div className="flex flex-wrap items-baseline gap-3 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">수집 현황</h1>
        <span className="text-[12.5px] font-semibold">
          {settings.enabled ? <span className="text-up">수집 켜짐</span> : <span className="text-fg-3">수집 꺼짐</span>}
        </span>
        <div className="ml-auto">
          <AdminNav current="/admin/status" />
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-4">
        <Panel
          title="작업"
          note="한 번도 안 돈 작업은 스케줄러가 아직 닿지 않았다는 뜻입니다. 마지막 성공이 계속 오래됐다면 오류를 봅니다."
        >
          {/* 좁은 화면에서 표가 밀려 나가지 않게 감싼다 */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-[12.5px]">
              <thead className="text-fg-3">
                <tr className="text-left">
                  <th className="pb-2 font-medium">이름</th>
                <th className="pb-2 font-medium">마지막 실행</th>
                <th className="pb-2 font-medium">마지막 성공</th>
                <th className="pb-2 font-medium">횟수</th>
              </tr>
            </thead>
            <tbody>
              {JOB_NAMES.map((name) => {
                const state = states.get(name);
                return (
                  <tr key={name} className="border-t border-line">
                    <td className="py-2 font-mono">{name}</td>
                    <td className="py-2 text-fg-2">{state ? when(state.lastRunAt) : "실행 기록 없음"}</td>
                    <td className="py-2 text-fg-2">{state ? when(state.lastSuccessAt) : "—"}</td>
                    <td className="py-2 font-mono text-fg-2">{state?.runs ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>

          {jobStates
            .filter((job) => job.lastError)
            .map((job) => (
              <p key={job.name} className="mt-3 rounded-[10px] border border-down/40 bg-down/10 px-3 py-2 text-[12px] text-down">
                <span className="font-mono font-semibold">{job.name}</span> {job.lastError}
              </p>
            ))}
        </Panel>

        <Panel
          title="랭킹 스냅샷"
          note="작업 실행 상태는 위 표의 ranking-refresh 한 곳에서만 확인하고, 여기서는 마지막으로 저장된 시즌 결과의 나이만 봅니다."
        >
          {rankingSeason ? (
            <dl className="flex flex-wrap gap-x-8 gap-y-3 text-[12.5px]">
              <div>
                <dt className="text-fg-3">현재 시즌</dt>
                <dd className="mt-1 font-mono font-semibold">{rankingSeason.key}</dd>
              </div>
              <div>
                <dt className="text-fg-3">기간</dt>
                <dd className="mt-1 font-semibold">
                  {rankingSeason.startsAt.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}
                  {" – "}
                  {rankingSeason.endsAt.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}
                </dd>
              </div>
              <div>
                <dt className="text-fg-3">마지막 집계</dt>
                <dd className={`mt-1 font-semibold ${rankingStale ? "text-down" : "text-up"}`}>
                  {rankingSeason.refreshedAt ? when(rankingSeason.refreshedAt) : "집계 없음"}
                  {rankingSeason.refreshedAt && rankingStale && " · 오래됨"}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-[13px] text-fg-3">아직 생성된 랭킹 시즌이 없습니다.</p>
          )}
        </Panel>

        {down.length > 0 && (
          <Panel
            title="응답하지 않는 제품"
            note={`${DOWN_THRESHOLD}회 넘게 연속으로 실패한 것입니다. 자동으로 내리지 않습니다 — 배포가 잠깐 흔들린 것과 서비스가 끝난 것을 응답 코드만으로 가를 수 없습니다.`}
          >
            <ul className="flex flex-col gap-1.5 text-[12.5px]">
              {down.map((item) => (
                <li key={item.slug} className="flex flex-wrap items-baseline gap-x-2">
                  <a href={`/p/${item.slug}`} className="font-semibold hover:text-accent">
                    {item.name}
                  </a>
                  <span className="font-mono text-[11.5px] text-fg-3">
                    {item.status === 0 ? "접속 실패" : `HTTP ${item.status}`} · {item.failures}회 연속
                    {item.downSince && ` · ${when(item.downSince)}부터`}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel title="프론티어" note="조사 대상 큐입니다. 대기가 0이면 crawl-seed가 더 찾아야 합니다.">
          <Counts counts={frontier} empty="아직 발견한 레포가 없습니다." />
        </Panel>

        <Panel title="후보" note="판정 결과입니다. 심사 대기는 사람이 가를 것, 발행 대기는 다음 발행 틱이 올릴 것입니다.">
          <Counts counts={candidates} empty="아직 판정한 것이 없습니다." />
        </Panel>

        {topClicked.length > 0 && (
          <Panel
            title="많이 눌린 제품 (30일)"
            note="하루 단위로 굴린 집계입니다. 원천은 35일이면 지우므로 오래된 구간은 여기서만 볼 수 있습니다."
          >
            <ul className="flex flex-col gap-1.5 text-[12.5px]">
              {topClicked.map((item) => (
                <li key={item.slug} className="flex items-baseline gap-2">
                  <a href={`/p/${item.slug}`} className="font-semibold hover:text-accent">
                    {item.slug}
                  </a>
                  <span className="font-mono text-fg-3">{item.clicks}회</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel
          title="신호별 수율"
          note="어떤 검색어가 쓸 만한 것을 데려오는지입니다. 켜고 끄기 전에 숫자로 봅니다."
        >
          {signals.size === 0 ? (
            <p className="text-[13px] text-fg-3">아직 판정한 것이 없습니다.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-[12.5px]">
                <thead className="text-fg-3">
                  <tr className="text-left">
                    <th className="pb-2 font-medium">신호</th>
                  <th className="pb-2 font-medium">판정한 수</th>
                  <th className="pb-2 font-medium">목록에 오른 수</th>
                  <th className="pb-2 font-medium">수율</th>
                </tr>
              </thead>
              <tbody>
                {[...signals]
                  .sort((a, b) => b[1].kept / b[1].judged - a[1].kept / a[1].judged)
                  .map(([signal, { judged, kept }]) => (
                    <tr key={signal} className="border-t border-line">
                      <td className="py-2">{signal}</td>
                      <td className="py-2 font-mono text-fg-2">{judged}</td>
                      <td className="py-2 font-mono text-fg-2">{kept}</td>
                      <td className="py-2 font-mono font-bold">{Math.round((kept / judged) * 100)}%</td>
                    </tr>
                  ))}
              </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="거부 사유"
          note="어떤 규칙이 얼마나 거르고 있는지입니다. 한 사유가 압도적이면 그 기준부터 의심합니다."
        >
          {rejections.length === 0 ? (
            <p className="text-[13px] text-fg-3">아직 거부한 것이 없습니다.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {rejections.map((row) => (
                <li key={row.reason} className="flex items-center gap-3 text-[12.5px]">
                  <span className="w-[150px] shrink-0 text-fg-2">{REASON_LABELS[row.reason] ?? row.reason}</span>
                  <span className="h-[6px] rounded-full bg-accent/60" style={{ width: `${(row.count / rejectedTotal) * 60}%` }} />
                  <span className="font-mono text-fg-3">
                    {row.count} · {Math.round((row.count / rejectedTotal) * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </main>
  );
}
