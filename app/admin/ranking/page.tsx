import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Panel } from "@/components/Panel";
import { SeasonPolicy } from "@/components/SeasonPolicy";
import { currentAdmin } from "@/lib/auth/admin";
import type { RankingPolicyRevision } from "@/lib/db/schema";
import {
  DEFAULT_RANKING_POLICY,
  parseRankingPolicy,
  type RankingPolicy,
} from "@/lib/domain/ranking/policy";
import type { CalculatedEntry } from "@/lib/domain/ranking/refresh";
import { getRankingAdminState } from "@/lib/domain/ranking/view";
import { AdminNav } from "../AdminNav";
import { cancelRankingPolicy } from "./actions";
import { RankingPolicyForm } from "./RankingPolicyForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "랭킹 설정 — NoMoreVibe", robots: { index: false } };

function dateTime(value: Date | null): string {
  if (!value) return "없음";
  return value.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function dateRange(startsAt: Date, endsAt: Date): string {
  const format = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `${format.format(startsAt)} – ${format.format(endsAt)}`;
}

function remaining(endsAt: Date): string {
  const milliseconds = endsAt.getTime() - Date.now();
  if (milliseconds <= 0) return "경계 처리 대기";
  const hours = Math.ceil(milliseconds / 3_600_000);
  if (hours < 24) return `${hours}시간 남음`;
  return `${Math.ceil(hours / 24)}일 남음`;
}

function policyRows(policy: RankingPolicy): Array<[string, string]> {
  return [
    ["랭킹 기준", policy.scoring.mode === "unique_visitors" ? "고유 유입자" : "유효 방문"],
    ["시즌 주기", policy.season.cadence === "weekly" ? "주간" : "월간"],
    ["출시 참가 기간", `${policy.eligibility.launchWindowDays}일`],
    ["최소 참가 제품", `${policy.eligibility.minimumProducts}개`],
    ["최대 확장 기간", `${policy.eligibility.maximumWindowDays}일`],
    ["전체 랭킹", `${policy.leaderboard.limit}개`],
    ["이번 시즌 보드", `${policy.boards.weeklyLimit}개`],
    ["새로 검증됨", `${policy.boards.verifiedNewLimit}개`],
    ["새로 발견됨", `${policy.boards.discoveredNewLimit}개`],
    ["급상승", policy.scoring.mode === "unique_visitors"
      ? `${policy.trend.windowHours}시간 / 이전 ${policy.trend.minimumPreviousUniqueVisitors}명 / ${policy.trend.limit}개`
      : `${policy.trend.windowHours}시간 / 이전 ${policy.trend.minimumPreviousClicks}회 / ${policy.trend.limit}개`],
    ["쿨다운", policy.cooldown.enabled ? policy.cooldown.tiers.map((tier) => (
      `${tier.rankFrom}–${tier.rankTo}위 ${tier.factorsBasisPoints.map((factor) => `${factor / 100}%`).join("→")}`
    )).join(" · ") || "사용 · 구간 없음" : "사용 안 함"],
  ];
}

function PolicyDiff({ active, scheduled }: { active: RankingPolicy; scheduled: RankingPolicy }) {
  const before = new Map(policyRows(active));
  const changed = policyRows(scheduled).filter(([label, value]) => before.get(label) !== value);

  if (changed.length === 0) {
    return <p className="text-[13px] text-fg-3">현재 정책과 값이 같습니다.</p>;
  }

  return (
    <ul className="flex flex-col gap-2 text-[13px]">
      {changed.map(([label, value]) => (
        <li key={label} className="grid gap-1 sm:grid-cols-[130px_1fr]">
          <span className="font-semibold">{label}</span>
          <span className="text-fg-2">
            <span className="line-through opacity-60">{before.get(label)}</span>
            <span className="mx-2">→</span>
            <span className="font-semibold text-accent">{value}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function RevisionList({ revisions }: { revisions: RankingPolicyRevision[] }) {
  const stateLabel = { applied: "적용됨", scheduled: "예약됨", cancelled: "취소됨" } as const;
  if (revisions.length === 0) return <p className="text-[13px] text-fg-3">아직 저장된 정책 버전이 없습니다.</p>;

  return (
    <ul className="flex flex-col gap-2 text-[13px]">
      {[...revisions].reverse().map((revision) => (
        <li key={revision.id} className="flex flex-wrap gap-x-2 border-t border-line pt-2 first:border-0 first:pt-0">
          <span className="font-mono font-semibold">#{revision.id}</span>
          <span>{stateLabel[revision.state]}</span>
          <span className="text-fg-2">{revision.createdBy}</span>
          <span className="text-fg-3">작성 {dateTime(revision.createdAt)}</span>
          {revision.appliedAt && <span className="text-fg-3">적용 {dateTime(revision.appliedAt)}</span>}
          {revision.cancelledAt && <span className="text-fg-3">취소 {dateTime(revision.cancelledAt)}</span>}
        </li>
      ))}
    </ul>
  );
}

function dualPreviewRows(
  current: CalculatedEntry[],
  proposed: CalculatedEntry[],
  limit: number,
): Array<{
  slug: string;
  current: CalculatedEntry | null;
  proposed: CalculatedEntry | null;
}> {
  const top = (entries: CalculatedEntry[]) => [...entries]
    .sort((left, right) => left.rank - right.rank || left.slug.localeCompare(right.slug))
    .slice(0, limit);
  const currentBySlug = new Map(current.map((entry) => [entry.slug, entry]));
  const proposedBySlug = new Map(proposed.map((entry) => [entry.slug, entry]));
  const comparisonSlugs = new Set([
    ...top(current).map((entry) => entry.slug),
    ...top(proposed).map((entry) => entry.slug),
  ]);
  return [...comparisonSlugs]
    .map((slug) => ({
      slug,
      current: currentBySlug.get(slug) ?? null,
      proposed: proposedBySlug.get(slug) ?? null,
    }))
    .sort((left, right) => (
      (left.proposed?.rank ?? Number.MAX_SAFE_INTEGER)
      - (right.proposed?.rank ?? Number.MAX_SAFE_INTEGER)
      || (left.current?.rank ?? Number.MAX_SAFE_INTEGER)
      - (right.current?.rank ?? Number.MAX_SAFE_INTEGER)
      || left.slug.localeCompare(right.slug)
    ));
}

export default async function AdminRankingPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const state = await getRankingAdminState();
  const latestApplied = [...state.revisions].reverse().find((revision) => revision.state === "applied");
  const activePolicy = parseRankingPolicy(
    state.active?.policy ?? latestApplied?.values ?? DEFAULT_RANKING_POLICY,
  );
  const formPolicy = parseRankingPolicy(state.scheduled?.values ?? activePolicy);
  const showDualPreview = activePolicy.scoring.mode === "valid_visits";
  const comparison = dualPreviewRows(
    state.currentPreview,
    state.proposedUniquePreview,
    formPolicy.leaderboard.limit,
  );

  return (
    <main className="mx-auto max-w-[900px] px-6 pb-20">
      <div className="flex flex-wrap items-baseline gap-3 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">랭킹 설정</h1>
        <span className="text-[13px] text-fg-3">{admin.login}</span>
        <div className="ml-auto"><AdminNav current="/admin/ranking" /></div>
      </div>

      <p className="mt-2 max-w-[68ch] text-[13.5px] leading-[1.7] text-fg-2">
        활성 시즌의 정책은 잠겨 있습니다. 여기서 저장한 변경은 다음 시즌 경계에 한 번 적용됩니다.
      </p>

      <div className="mt-6 flex flex-col gap-4">
        <Panel title="현재 시즌" note="마지막으로 성공한 스냅샷을 보여줍니다.">
          {state.active ? (
            <dl className="grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
              <Summary label="시즌" value={`${state.active.key}${state.active.isTransition ? " · 전환" : ""}`} />
              <Summary label="기간" value={dateRange(state.active.startsAt, state.active.endsAt)} />
              <Summary label="남은 시간" value={remaining(state.active.endsAt)} />
              <Summary label="확정 참가 기간" value={`${state.active.effectiveLaunchWindowDays}일`} />
              <Summary label="참가 제품" value={`${state.activeMetrics.eligibleProducts.toLocaleString("ko-KR")}개`} />
              <Summary label="유효 방문" value={`${state.activeMetrics.validClicks.toLocaleString("ko-KR")}회`} />
              <Summary label="마지막 집계" value={dateTime(state.active.refreshedAt)} />
            </dl>
          ) : (
            <p className="text-[13px] text-fg-3">아직 생성된 시즌이 없습니다. 첫 랭킹 집계 후 표시됩니다.</p>
          )}
        </Panel>

        <Panel
          title="고유 유입자 전환 준비"
          note="수집 시작부터 7일이 지난 뒤 예약할 수 있으며, 예약해도 현재 시즌은 바뀌지 않습니다."
          tone={state.collectionReadiness.ready ? "default" : "warn"}
        >
          <dl className="grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-3">
            <Summary label="수집 시작" value={dateTime(state.collectionReadiness.startedAt)} />
            <Summary label="예약 가능" value={dateTime(state.collectionReadiness.readyAt)} />
            <Summary label="상태" value={state.collectionReadiness.ready ? "예약 가능" : "집계 중"} />
          </dl>
          <p className="mt-3 text-[13px] leading-[1.7] text-fg-2">
            정책을 예약하면 현재 순위가 아니라 다음 시즌 경계부터 적용됩니다.
          </p>
        </Panel>

        <Panel title="활성 정책 · 잠김" note="이 스냅샷은 현재 시즌이 끝날 때까지 바뀌지 않습니다.">
          <SeasonPolicy policy={activePolicy} />
        </Panel>

        {state.scheduled && (
          <Panel
            title={`예약된 정책 #${state.scheduled.id}`}
            note={`${state.scheduled.createdBy} · ${dateTime(state.scheduled.createdAt)} · 다음 시즌부터 적용`}
            tone="warn"
          >
            <PolicyDiff active={activePolicy} scheduled={parseRankingPolicy(state.scheduled.values)} />
            <form action={cancelRankingPolicy} className="mt-4">
              <button type="submit" className="rounded-[9px] border border-down/40 px-3 py-2 text-[13px] font-semibold text-down hover:bg-down/10">
                예약 취소
              </button>
            </form>
          </Panel>
        )}

        <Panel title="다음 시즌 정책" note={state.scheduled ? "저장하면 기존 예약을 취소하고 새 버전으로 교체합니다." : "저장하면 새 정책 버전을 예약합니다."}>
          <RankingPolicyForm initialPolicy={formPolicy} />
        </Panel>

        <Panel
          title="예상 결과"
          note={showDualPreview
            ? "다음 시즌 정책의 공통 설정에 유효 방문 기준과 고유 유입자 기준을 각각 적용해 비교합니다. 예약 시 다음 시즌부터만 적용됩니다."
            : "현재 데이터에 다음 시즌 정책을 적용한 추정치입니다. 경계 전까지 방문과 참가 제품이 달라지므로 실제 결과를 보장하지 않습니다."}
        >
          {(showDualPreview ? comparison.length : state.preview.length) === 0 ? (
            <p className="text-[13px] text-fg-3">예상할 참가 제품이 없습니다.</p>
          ) : showDualPreview ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[13px]">
                <thead className="text-left text-fg-3">
                  <tr>
                    <th className="pb-2 font-medium">제품</th>
                    <th className="pb-2 font-medium">유효 방문 기준 순위</th>
                    <th className="pb-2 font-medium">유효 방문</th>
                    <th className="pb-2 font-medium">고유 유입자 기준 순위</th>
                    <th className="pb-2 font-medium">고유 유입자</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.map((row) => (
                    <tr key={row.slug} className="border-t border-line">
                      <td className="py-2 font-mono">{row.slug}</td>
                      <td className="py-2 font-mono font-bold">{row.current?.rank ?? "—"}</td>
                      <td className="py-2 font-mono">{row.current?.validClicks.toLocaleString("ko-KR") ?? "—"}</td>
                      <td className="py-2 font-mono font-bold">{row.proposed?.rank ?? "—"}</td>
                      <td className="py-2 font-mono">{row.proposed?.uniqueVisitors.toLocaleString("ko-KR") ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-[13px]">
                <thead className="text-left text-fg-3">
                  <tr><th className="pb-2 font-medium">순위</th><th className="pb-2 font-medium">제품</th><th className="pb-2 font-medium">{formPolicy.scoring.mode === "unique_visitors" ? "고유 유입자" : "유효 방문"}</th><th className="pb-2 font-medium">적용률</th><th className="pb-2 font-medium">변동률</th></tr>
                </thead>
                <tbody>
                  {state.preview.slice(0, formPolicy.leaderboard.limit).map((entry) => (
                    <tr key={entry.slug} className="border-t border-line">
                      <td className="py-2 font-mono font-bold">{entry.rank}</td>
                      <td className="py-2 font-mono">{entry.slug}</td>
                      <td className="py-2 font-mono">{(formPolicy.scoring.mode === "unique_visitors" ? entry.uniqueVisitors : entry.validClicks).toLocaleString("ko-KR")}</td>
                      <td className="py-2 font-mono">{entry.cooldownFactorBasisPoints / 100}%</td>
                      <td className="py-2 font-mono">{entry.changePercent === null ? "신규" : `${entry.changePercent}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="정책 버전" note="정책 버전은 수정하지 않고 적용·예약·취소 이력으로 남깁니다.">
          <RevisionList revisions={state.revisions} />
        </Panel>
      </div>
    </main>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-fg-3">{label}</dt>
      <dd className="mt-1 font-semibold">{value}</dd>
    </div>
  );
}
