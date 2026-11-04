import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { listJobStates } from "@/lib/jobs/runner";
import { isPausedJob } from "@/lib/jobs/status";
import { adminJobControlVersions } from "@/lib/operations/admin-job-control";
import { readConveyor } from "@/lib/operations/conveyor";
import { STATION_JOBS } from "@/lib/operations/flow-response";
import { logger } from "@/lib/observability/logger";
import { PageStamp } from "@/app/(operator)/admin/components/PageStamp";
import { OPS_FRESH_COOKIE } from "../status/fresh";
import { jobControlCsrf } from "../status/job-control-csrf";
import { readOperatorDesk } from "./desk";
import { FlowBoard, type FlowControls } from "./FlowBoard";
import "./flow.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "전체 흐름 — NoMoreVibe", robots: { index: false } };

const quiet = (event: string) => (error: unknown) => {
  logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" });
  return null;
};

/** 칸마다 멈추고 다시 켤 수 있는 작업의 지금 상태 — 운영센터 작업 상세와 같은 읽기(jobs 행·작업 제어 판) */
async function readControls(admin: { login: string; exp: number }): Promise<FlowControls> {
  const names = new Set(Object.values(STATION_JOBS).flat().map((row) => row.job));
  const [states, versions] = await Promise.all([listJobStates(), adminJobControlVersions()]);
  const now = Date.now();
  const secret = authSecret();
  return {
    jobs: Object.fromEntries(states.filter((job) => names.has(job.name)).map((job) => [job.name, {
      paused: isPausedJob(job, now), notBefore: job.notBefore?.toISOString() ?? null, version: versions[job.name] ?? 0,
      lastSuccessAt: job.lastSuccessAt?.toISOString() ?? null, lastError: !!job.lastError }])),
    csrf: secret ? { token: jobControlCsrf(admin, secret), expiresAt: admin.exp } : null,
  };
}

/**
 * 전체 흐름 — 발행 전 과정 한 장: 탐색 → 검수 → 프로필 준비 → 발행 → 키워드 등록의 흐름과 처리량, 가장 막힌 곳과 까닭,
 * 그 자리의 장애 대응, 그리고 1인 관리자 필수 칸(할 일 — 경보·사람 판단·자리 비운 사이·모두 보기, 최근 바뀐 설정·장비·점검 창).
 * 이 화면이 직접 바꾸는 것은 작업 멈춤·재개(운영센터와 같은 서버 동작, 사유 필수, 작업 로그) 하나다. 나머지는 각 조치의 링크가 보내는 화면에서 한다.
 */
export default async function AdminFlowPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const fresh = (await cookies()).has(OPS_FRESH_COOKIE);
  const [conveyor, desk, controls] = await Promise.all([
    readConveyor(fresh).catch(quiet("conveyor.unavailable")),
    readOperatorDesk(admin.login, fresh).catch(quiet("desk.unavailable")),
    readControls(admin).catch(quiet("flow.controls_unavailable")),
  ]);
  return (
    <main className="flex flex-col gap-4 pb-10 pt-6"><PageStamp />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-[22px] font-extrabold tracking-tight">전체 흐름</h1>
        <p className="text-[13px] text-fg-3">칸을 누르면 자세히와 장애 대응이 열립니다.</p>
      </div>
      {conveyor ? <FlowBoard data={conveyor} desk={desk} controls={controls ?? undefined} />
        : <p role="status" className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[14px] text-fg-2">
          흐름을 읽지 못했습니다 — 다음 자동 갱신에서 다시 읽습니다.</p>}
    </main>
  );
}
