import type { Metadata } from "next";
import { redirect } from "next/navigation";
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
import { formatDetailTime } from "@/lib/format/time";
import { cancelRankingPolicy } from "./actions";
import { RankingPolicyForm } from "./RankingPolicyForm";
import styles from "./ranking.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "랭킹 설정 — NoMoreVibe", robots: { index: false } };

/** 시각 표기는 lib/format/time 하나로(ADM-26) — 상세 표기 "2026-10-08 13:38:13 KST" */
function dateTime(value: Date | null): string {
  return formatDetailTime(value, "없음");
}

/** 시즌 기간 "10-01 00:00 – 11-01 00:00 KST" — 상세 표기에서 해·초를 뗀다(한 칸에 둘이 들어가야 한다) */
function dateRange(startsAt: Date, endsAt: Date): string {
  const short = (value: Date) => formatDetailTime(value).slice(5, 16);
  return `${short(startsAt)} – ${short(endsAt)} KST`;
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
    ["반복 방문 가중치", policy.scoring.mode === "unique_visitors" ? `${policy.scoring.repeatVisitWeightBasisPoints / 100}%` : "해당 없음"],
    ["추가 방문 상한", policy.scoring.mode === "unique_visitors" ? `${policy.scoring.maxExtraVisitsPerUnique}회` : "해당 없음"],
    ["최소 고유 유입자", policy.scoring.mode === "unique_visitors" ? `${policy.scoring.minimumUniqueVisitors}명` : "해당 없음"],
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
    <ul className={styles.diffList}>
      {changed.map(([label, value]) => (
        <li key={label}>
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
    <ul className={styles.revisions}>
      {[...revisions].reverse().map((revision) => (
        <li key={revision.id}>
          <div className={styles.revisionIdentity}>
            <strong>#{revision.id}</strong>
            <span className={styles.badge} data-tone={revision.state === "applied" ? "success" : undefined}>{stateLabel[revision.state]}</span>
          </div>
          <span className="text-fg-2">{revision.createdBy}</span>
          <div className={styles.revisionDates}>
            <span>작성 {dateTime(revision.createdAt)}</span>
            {revision.appliedAt && <span>적용 {dateTime(revision.appliedAt)}</span>}
            {revision.cancelledAt && <span>취소 {dateTime(revision.cancelledAt)}</span>}
          </div>
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
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>시즌 운영</p>
          <h1>랭킹 설정</h1>
          <p className={styles.intro}>현재 시즌을 확인하고, 다음 시즌의 집계 기준을 준비하세요.</p>
        </div>
        <span className={styles.operator}>관리자 · {admin.login}</span>
      </header>

      <nav className={styles.sectionNav} aria-label="랭킹 설정 바로가기">
        <a href="#ranking-current">현재 시즌</a>
        <a href="#ranking-policy">다음 시즌 정책</a>
        <a href="#ranking-preview">예상 결과</a>
        <a href="#ranking-history">변경 이력</a>
      </nav>

      <section id="ranking-current" className={styles.card} aria-labelledby="current-title">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="current-title">현재 시즌</h2>
            <p>마지막으로 성공한 집계 기준입니다. 모든 시간은 한국 시간(KST)입니다.</p>
          </div>
          <span className={styles.badge}>{state.active ? "정책 잠김" : "집계 대기"}</span>
        </div>
        {state.active ? (
          <>
            <dl className={styles.metrics}>
              <Summary label="시즌" value={state.active.key} detail={state.active.isTransition ? "전환 시즌" : activePolicy.season.cadence === "weekly" ? "주간 시즌" : "월간 시즌"} />
              <Summary label="참가 제품" value={state.activeMetrics.eligibleProducts.toLocaleString("ko-KR")} detail="개" />
              <Summary label="유효 방문" value={state.activeMetrics.validClicks.toLocaleString("ko-KR")} detail="회" />
              <Summary label="시즌 종료까지" value={remaining(state.active.endsAt)} />
            </dl>
            <dl className={styles.facts}>
              <Summary label="시즌 기간" value={dateRange(state.active.startsAt, state.active.endsAt)} />
              <Summary label="확정 참가 기간" value={`${state.active.effectiveLaunchWindowDays}일`} />
              <Summary label="마지막 집계" value={dateTime(state.active.refreshedAt)} />
            </dl>
          </>
        ) : (
          <p className={styles.empty}>아직 생성된 시즌이 없습니다. 첫 랭킹 집계 후 표시됩니다.</p>
        )}
        <details className={styles.activePolicy}>
          <summary>
            <span>활성 정책 상세</span>
            <span className={styles.summaryMeta}>{activePolicy.scoring.mode === "unique_visitors" ? "고유 유입자" : "유효 방문"} 기준 · 전체 {activePolicy.leaderboard.limit}개</span>
          </summary>
          <div className={styles.policyDetails}>
            <p className={styles.hint}>현재 시즌이 끝날 때까지 이 정책은 바뀌지 않습니다.</p>
            <SeasonPolicy policy={activePolicy} />
          </div>
        </details>
      </section>

      <section className={styles.readiness} aria-labelledby="readiness-title">
        <div>
          <div className={styles.inlineHeading}>
            <h2 id="readiness-title">고유 유입자 전환 준비</h2>
            <span className={styles.badge} data-tone={state.collectionReadiness.ready ? "success" : "warning"}>
              {state.collectionReadiness.ready ? "예약 가능" : "집계 중"}
            </span>
          </div>
          <p>수집 시작부터 7일 후 예약할 수 있습니다. 예약한 기준은 다음 시즌부터 적용됩니다.</p>
        </div>
        <dl className={styles.readinessDates}>
          <Summary label="수집 시작" value={dateTime(state.collectionReadiness.startedAt)} />
          <Summary label="예약 가능 시점" value={dateTime(state.collectionReadiness.readyAt)} />
        </dl>
      </section>

      {state.scheduled && (
        <section className={`${styles.card} ${styles.scheduled}`} aria-labelledby="scheduled-title">
          <div className={styles.sectionHeading}>
            <div>
              <h2 id="scheduled-title">예약된 정책 #{state.scheduled.id}</h2>
              <p>{state.scheduled.createdBy} · {dateTime(state.scheduled.createdAt)} · 다음 시즌부터 적용</p>
            </div>
            <form action={cancelRankingPolicy}>
              <button type="submit" className={styles.cancelButton}>예약 취소</button>
            </form>
          </div>
          <PolicyDiff active={activePolicy} scheduled={parseRankingPolicy(state.scheduled.values)} />
        </section>
      )}

      <section id="ranking-policy" className={styles.editor} aria-labelledby="policy-title">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="policy-title">다음 시즌 정책</h2>
            <p>{state.scheduled ? "저장하면 기존 예약을 새 버전으로 교체합니다." : "설정을 저장하면 다음 시즌에 적용할 정책으로 예약합니다."}</p>
          </div>
          <span className={styles.badge}>다음 시즌부터 적용</span>
        </div>
        <RankingPolicyForm initialPolicy={formPolicy} />
      </section>

      <section id="ranking-preview" className={styles.card} aria-labelledby="preview-title">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="preview-title">예상 결과</h2>
            <p>{state.scheduled ? `저장된 예약 정책 #${state.scheduled.id}` : "현재 활성 정책"} 기준입니다. 저장 전 편집한 값은 반영되지 않습니다.</p>
          </div>
          <span className={styles.badge}>참고용 추정치</span>
        </div>
        <p className={styles.previewNote}>{showDualPreview
          ? "같은 참가·노출 설정에 유효 방문과 고유 유입자 기준을 각각 적용해 비교합니다. 실제 다음 시즌 결과는 달라질 수 있습니다."
          : "현재 데이터에 정책을 적용한 추정치입니다. 시즌 시작 전까지 방문과 참가 제품이 달라질 수 있습니다."}</p>
        {(showDualPreview ? comparison.length : state.preview.length) === 0 ? (
          <div className={styles.empty}>
            <strong>예상할 참가 제품이 없습니다.</strong>
            <p>참가 조건에 맞는 제품과 방문 데이터가 쌓이면 이곳에 표시됩니다.</p>
          </div>
        ) : showDualPreview ? (
          <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="랭킹 기준별 예상 결과">
            <table className={styles.previewTable}>
              <thead>
                <tr>
                  <th scope="col">제품</th>
                  <th scope="col">유효 방문 기준 순위</th>
                  <th scope="col">유효 방문</th>
                  <th scope="col">고유 유입자 기준 순위</th>
                  <th scope="col">고유 유입자</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map((row) => (
                  <tr key={row.slug}>
                    <td>{row.slug}</td>
                    <td className={styles.rank}>{row.current?.rank ?? "—"}</td>
                    <td>{row.current?.validClicks.toLocaleString("ko-KR") ?? "—"}</td>
                    <td className={styles.rank}>{row.proposed?.rank ?? "—"}</td>
                    <td>{row.proposed?.uniqueVisitors.toLocaleString("ko-KR") ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="랭킹 예상 결과">
            <table className={styles.previewTable}>
              <thead>
                <tr><th scope="col">제품</th><th scope="col">순위</th><th scope="col">{formPolicy.scoring.mode === "unique_visitors" ? "고유 유입자" : "유효 방문"}</th><th scope="col">쿨다운 적용률</th><th scope="col">변동률</th></tr>
              </thead>
              <tbody>
                {state.preview.slice(0, formPolicy.leaderboard.limit).map((entry) => (
                  <tr key={entry.slug}>
                    <td>{entry.slug}</td>
                    <td className={styles.rank}>{entry.rank}</td>
                    <td>{(formPolicy.scoring.mode === "unique_visitors" ? entry.uniqueVisitors : entry.validClicks).toLocaleString("ko-KR")}</td>
                    <td>{entry.cooldownFactorBasisPoints / 100}%</td>
                    <td>{entry.changePercent === null ? "신규" : `${entry.changePercent}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section id="ranking-history" className={styles.card} aria-labelledby="history-title">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="history-title">정책 변경 이력</h2>
            <p>적용·예약·취소한 정책 버전과 처리 시간을 확인합니다.</p>
          </div>
          <span className={styles.badge}>{state.revisions.length}개 버전</span>
        </div>
        <RevisionList revisions={state.revisions} />
      </section>
    </main>
  );
}

function Summary({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}{detail && <span>{detail}</span>}</dd>
    </div>
  );
}
