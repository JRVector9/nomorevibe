import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { listJobStates } from "@/lib/jobs/runner";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { isPausedJob, jobStatusLabel } from "@/lib/jobs/status";
import { adminJobControlVersions } from "@/lib/operations/admin-job-control";
import { readConveyor } from "@/lib/operations/conveyor";
import { readFlowRankEditor } from "@/lib/operations/flow-rank-editor-read";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { heldReactionComments } from "@/lib/domain/reactions/review";
import { PUBLIC_TRANSLATION_JOBS, STATION_JOBS } from "@/lib/operations/flow-response";
import { logger } from "@/lib/observability/logger";
import { PageStamp } from "@/app/(operator)/admin/components/PageStamp";
import { OPS_FRESH_COOKIE } from "../status/fresh";
import { jobControlCsrf } from "../status/job-control-csrf";
import { readOperatorDesk } from "./desk";
import type { FlowControls } from "./FlowBoard";
import { PrototypeFlow } from "./PrototypeFlow";
import "./flow.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "전체 흐름 — NoMoreVibe", robots: { index: false } };

const quiet = (event: string) => (error: unknown) => {
  logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" });
  return null;
};

/** 칸마다 멈추고 다시 켤 수 있는 작업의 지금 상태 — 운영센터 작업 상세와 같은 읽기(jobs 행·작업 제어 판) */
async function readControls(admin: { login: string; exp: number }): Promise<FlowControls> {
  const names = new Set([...Object.values(STATION_JOBS).flat(), ...PUBLIC_TRANSLATION_JOBS].map((row) => row.job));
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
  const [conveyor, desk, controls, editor, reactions] = await Promise.all([
    readConveyor(fresh).catch(quiet("conveyor.unavailable")),
    readOperatorDesk(admin.login, fresh).catch(quiet("desk.unavailable")),
    readControls(admin).catch(quiet("flow.controls_unavailable")),
    adminWorkspaceReadOnly() ? Promise.resolve(null) : readFlowRankEditor(),
    heldReactionComments(1).catch(quiet("flow.reactions_unavailable")),
  ]);
  return (
    <main className="stack pb-10 pt-4"><PageStamp />
      <h1 className="admin-vh">운영 홈 · 실시간 전체 흐름</h1>
      {conveyor ? <PrototypeFlow data={conveyor} desk={desk} controls={controls ?? { jobs: {}, csrf: null }} editor={editor} tab={tab} reactionRequests={reactions?.count ?? null} />
        : <p role="status" className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[14px] text-fg-2">
          흐름을 읽지 못했습니다 — 다음 자동 갱신에서 다시 읽습니다.</p>}
    </main>
  );
}
