import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { listJobStates } from "@/lib/jobs/runner";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { isPausedJob, jobStatusLabel } from "@/lib/jobs/status";
import { adminJobControlVersions } from "@/lib/operations/admin-job-control";
import { readConveyor } from "@/lib/operations/conveyor";
import { SOCIAL_FLOW_JOBS } from "@/lib/operations/flow-overview-read";
import { readFlowRankEditor } from "@/lib/operations/flow-rank-editor-read";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { heldReactionComments } from "@/lib/domain/reactions/review";
import { PUBLIC_TRANSLATION_JOBS, STATION_JOBS } from "@/lib/operations/flow-response";
import { logger } from "@/lib/observability/logger";
import { PageStamp } from "@/app/(operator)/admin/components/PageStamp";
import { OPS_FRESH_COOKIE } from "../status/fresh";
import { jobControlCsrf } from "../status/job-control-csrf";
import { readOperatorAway, readOperatorChanges, readOperatorDeskShared, readOperatorDiagnostics } from "./desk";
import type { FlowControls } from "./FlowBoard";
import { FlowBoard } from "./FlowBoard";
import { HumanModelSettings } from "./HumanModelSettings";
import { PrototypeFlow, PrototypeFlowAway, PrototypeFlowChanges } from "./PrototypeFlow";
import type { OperatorDesk } from "@/lib/operations/operator-desk-model";
import { FlowOverviewSummary, SocialFlowSummary } from "./FlowOverview";
import "./flow.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "전체 흐름 — NoMoreVibe", robots: { index: false } };

const quiet = (event: string) => (error: unknown) => {
  logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" });
  return null;
};

/** 칸마다 멈추고 다시 켤 수 있는 작업의 지금 상태 — 운영센터 작업 상세와 같은 읽기(jobs 행·작업 제어 판) */
async function readControls(admin: { login: string; exp: number }): Promise<FlowControls> {
  const names = new Set([...Object.values(STATION_JOBS).flat(), ...PUBLIC_TRANSLATION_JOBS].map((row) => row.job).concat([...SOCIAL_FLOW_JOBS]));
  const [states, versions] = await Promise.all([listJobStates(), adminJobControlVersions()]);
  const now = Date.now();
  const secret = authSecret();
  return {
    measuredAt: new Date(now).toISOString(),
    jobs: Object.fromEntries(states.filter((job) => names.has(job.name)).map((job) => [job.name, {
      paused: isPausedJob(job, now), notBefore: job.notBefore?.toISOString() ?? null, version: versions[job.name] ?? 0,
      lastSuccessAt: job.lastSuccessAt?.toISOString() ?? null, lastRunAt: job.lastRunAt?.toISOString() ?? null,
      workerSeenAt: job.workerSeenAt?.toISOString() ?? null, runtimeLabel: jobStatusLabel(job, now),
      execution: job.lockedAt ? now - job.lockedAt.getTime() > STALE_LOCK_MS ? "stale" : "locked" : "none", lastError: !!job.lastError }])),
    csrf: secret && !adminWorkspaceReadOnly() ? { token: jobControlCsrf(admin, secret), expiresAt: admin.exp } : null,
  };
}

/**
 * 전체 흐름 — 탐색 → 검수 → 프로필 준비 → 발행 → 공개. 검색·번역은 공개 후 별도 분기로 보인다.
 * 기존 공용 집계와 잡·역할 관측의 시각·단위를 함께 표시한다. 추가 모델 호출이나 DB 집계를 하지 않는다.
 * 그 자리의 장애 대응, 그리고 1인 관리자 필수 칸(할 일 — 경보·사람 판단·자리 비운 사이·모두 보기, 최근 바뀐 설정·장비·점검 창).
 * 이 화면이 직접 바꾸는 것은 작업 멈춤·재개(운영센터와 같은 서버 동작, 사유 필수, 작업 로그) 하나다. 나머지는 각 조치의 링크가 보내는 화면에서 한다.
 */
export default async function AdminFlowPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const fresh = (await cookies()).has(OPS_FRESH_COOKIE);
  const params = await searchParams;
  const tab = typeof params?.tab === "string" ? params.tab : "flow";
  const advanced = params?.advanced === "1";
  return (
    <main className="stack pb-10 pt-4"><PageStamp />
      <h1 className="admin-vh">운영 홈 · 실시간 전체 흐름</h1>
      <Suspense fallback={<p className="notice" aria-busy="true">운영 흐름을 읽는 중…</p>}>
        <FlowWorkspace admin={admin} fresh={fresh} tab={tab} advanced={advanced} />
      </Suspense>
    </main>
  );
}

type DeskRead = Promise<OperatorDesk | null>;

async function FlowWorkspace({ admin, fresh, tab, advanced }: {
  admin: NonNullable<Awaited<ReturnType<typeof currentAdmin>>>; fresh: boolean; tab: string; advanced: boolean;
}) {
  if (tab === "changes") {
    const desk = await readOperatorChanges(admin.login).catch(quiet("desk.changes_unavailable"));
    return <PrototypeFlowChanges desk={desk} />;
  }
  const diagnostics = tab === "diagnostics";
  const sharedDeskRead = (diagnostics ? readOperatorDiagnostics() : readOperatorDeskShared(fresh))
    .catch(quiet("desk.unavailable"));
  // Personal history streams into its panel; it never blocks the live belt or enters shared cache.
  const fullDeskRead: DeskRead | null = diagnostics ? null : sharedDeskRead.then(async base => base
    ? { ...base, away: await readOperatorAway(admin.login, base.measuredAt) } : null);
  const [conveyor, base, control, editor, reactions] = await Promise.all([
    readConveyor(fresh).catch(quiet("conveyor.unavailable")),
    sharedDeskRead,
    readControls(admin).catch(quiet("flow.controls_unavailable")),
    diagnostics ? Promise.resolve(null) : readFlowRankEditor(),
    diagnostics ? Promise.resolve(null) : heldReactionComments(1).catch(quiet("flow.reactions_unavailable")),
  ]);
  if (!conveyor) return <p role="status" className="notice">흐름을 읽지 못했습니다 — 다음 자동 갱신에서 다시 읽습니다.</p>;
  const desk: OperatorDesk | null = base ? { ...base, away: null } : null;
  const controls = control ?? { jobs: {}, csrf: null };
  const advancedContent = diagnostics && !advanced
    ? <><p className="small muted">전체 업무·장비·변경 기록과 모델 순위를 포함한 기존 고급 화면입니다.</p><Link prefetch={false} className="button mt" href="/admin/flow?tab=diagnostics&advanced=1#flow-advanced">고급 전체 흐름 불러오기 →</Link></>
    : <Suspense fallback={<p className="small muted" aria-busy="true">고급 운영 관측을 읽는 중…</p>}>
        <AdvancedFlow data={conveyor} controls={controls} deskRead={fullDeskRead} editor={editor} readRanks={diagnostics} login={admin.login} fresh={fresh} />
      </Suspense>;
  return <PrototypeFlow humanModelSettings={!diagnostics ? <Suspense fallback={<p className="small muted" aria-busy="true">AI 보조 모델 설정을 읽는 중…</p>}><HumanModelSettings /></Suspense> : undefined} data={conveyor} desk={desk} controls={controls} editor={editor} tab={tab}
    reactionRequests={reactions?.count ?? null} advancedContent={advancedContent}
    overviewContent={!diagnostics ? <Suspense fallback={<p className="notice" aria-busy="true">프로젝트 등록 수와 발행 추이를 읽는 중…</p>}>
      <FlowOverviewSummary data={conveyor} desk={desk} reactionRequests={reactions?.count ?? null} />
    </Suspense> : undefined}
    socialContent={!diagnostics ? <Suspense fallback={<p className="notice" aria-busy="true">SNS 수집·사이트 발행 흐름을 읽는 중…</p>}>
      <SocialFlowSummary jobs={controls.jobs} />
    </Suspense> : undefined}
    awayContent={fullDeskRead ? <Suspense fallback={<p className="small muted" aria-busy="true">부재 중 기록을 읽는 중…</p>}><AwayPanel deskRead={fullDeskRead} /></Suspense> : undefined} />;
}

async function AwayPanel({ deskRead }: { deskRead: DeskRead }) {
  return <PrototypeFlowAway desk={await deskRead} />;
}

async function AdvancedFlow({ data, controls, deskRead, editor, readRanks, login, fresh }: {
  data: Awaited<ReturnType<typeof readConveyor>>; controls: FlowControls; deskRead: DeskRead | null;
  editor: Awaited<ReturnType<typeof readFlowRankEditor>>; readRanks: boolean; login: string; fresh: boolean;
}) {
  const [desk, ranks] = await Promise.all([
    deskRead ?? readOperatorDeskShared(fresh).then(async base => ({ ...base, away: await readOperatorAway(login, base.measuredAt) })).catch(quiet("desk.unavailable")),
    readRanks ? readFlowRankEditor() : Promise.resolve(editor),
  ]);
  return <FlowBoard data={data} desk={desk} controls={controls} editor={ranks} />;
}
