import Link from "next/link";
import type { KoreanTaglineQueue } from "@/lib/domain/products/korean-taglines";
import { JOB_LABELS } from "@/lib/operations/contracts";
import { replicaHoldText, type ReplicaRead } from "@/lib/operations/replica-hold";
import { parseRuntimeLanes } from "@/lib/operations/worker-progress";
import { batchOwnerForJob, type BatchMode } from "@/lib/jobs/batches";
import { formatAgo } from "@/lib/format/time";
import { jobHref } from "../action-links";
import type { OwnerContext, WorkOwners } from "../work-owners";
import { WorkOwnerButtons } from "./WorkOwnerButtons";

const JOB = "product-tagline-ko";
const n = (value: number) => value.toLocaleString("ko-KR");

/** 역할 전체의 currentJob 대신, 실제 담당의 한국어 번역을 포함하는 기본 줄만 본다. */
export function koreanTranslationRuntime(ctx: Pick<OwnerContext, "roles" | "instances" | "now" | "batch">): string {
  const role = batchOwnerForJob(JOB, (ctx.batch?.mode ?? "legacy") as BatchMode);
  if (!role) return "작업 배치 전환 중";
  const lease = ctx.roles?.find((row) => row.role === role);
  if (!lease) return "담당 관측 미확인";
  if (!lease.ownerInstanceId) return "담당 없음";
  if (lease.secondsUntilExpiry === null) return "담당 기한 미확인";
  if (lease.secondsUntilExpiry <= 0) return "담당 기한 지남";
  const worker = ctx.instances.find((row) => row.role === role && row.instanceId === lease.ownerInstanceId);
  if (!worker) return "담당 워커 관측 없음";
  const age = Date.parse(ctx.now) - new Date(worker.observedAt).getTime();
  if (!Number.isFinite(age) || age > 45_000 || age < -45_000) return "담당 워커 관측 지연";
  if (!lease.ownerRelease || lease.ownerRelease === "unknown" || typeof worker.value.release !== "string"
    || !worker.value.release || worker.value.release === "unknown" || lease.ownerRelease !== worker.value.release) return "담당·워커 릴리스 미확인";
  if (worker.value.status !== "running") return "담당 워커 실행 미확인";
  const lane = parseRuntimeLanes(worker.value.lanes, role)?.find((row) => row.jobs.includes(JOB));
  if (!lane) return "기본 줄 관측 없음";
  if (lane.state === "running" && lane.currentJob === JOB) return "한국어 번역 실행 중";
  if (lane.state === "running" && lane.currentJob) return `같은 줄에서 ${JOB_LABELS[lane.currentJob] ?? lane.currentJob} 실행 중`;
  if (lane.state === "stopping") return "기본 줄 정지 중";
  return lane.state === "polling" ? "기본 줄 작업 확인 중" : "기본 줄 대기";
}

/** 0건·집계 보류에도 작업 존재와 실제 상태를 남긴다. */
export function KoreanTranslationStatus({ queue, owners, runtime, hasLastError, now }: {
  queue: ReplicaRead<KoreanTaglineQueue> | null | undefined; owners: WorkOwners | null;
  runtime: string; hasLastError: boolean; now: string;
}) {
  const stats = queue?.ok ? queue.value : null;
  const job = owners?.jobs.find((row) => row.name === JOB);
  return <section id="korean-translation" className="dash-card dash-8" aria-label="제품 소개 한국어 번역">
    <div className="dash-card-h"><h2>제품 소개 한국어 번역</h2><small>{stats ? `집계 ${formatAgo(stats.measuredAt, now)}` : "집계 미확인"}</small></div>
    <p className="dash-note">공개 제품의 기존 소개를 한국어 한 줄로 옮깁니다. 다국어 제품 정보 번역·심사 사유 번역과 별도 작업입니다.</p>
    {stats ? <dl className="mt-3 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
      <div><dt className="text-fg-3">즉시 처리</dt><dd className="font-mono text-lg">{n(stats.ready)}건</dd></div>
      <div><dt className="text-fg-3">재시도 예약</dt><dd className="font-mono text-lg">{n(stats.retryScheduled)}건</dd></div>
      <div><dt className="text-fg-3">품질 검사 중단</dt><dd className="font-mono text-lg">{n(stats.blocked)}건</dd></div>
      <div><dt className="text-fg-3">지난 1시간 완료</dt><dd className="font-mono text-lg">{n(stats.lastHour)}건</dd></div>
    </dl> : <p className="dash-note">대기 수 미확인{queue && !queue.ok ? ` — ${replicaHoldText(queue.reason)}` : " — 집계를 읽지 못했습니다"}. 0건을 뜻하지 않습니다.</p>}
    {stats && <p className="dash-note">현재 원문 번역 완료 {n(stats.done)} / 대상 {n(stats.eligible)}건. 이미 한국어인 소개는 제외합니다. 품질 검사 중단은 자동 재시도 한도에 닿은 제품입니다.</p>}
    <dl className="mt-3 grid gap-1 text-[13px]">
      <div><dt className="inline text-fg-3">작업 상태 </dt><dd className="inline">{job?.state ?? "실행 기록 미확인"}{hasLastError ? " · 최근 실패 기록 있음" : ""}</dd></div>
      <div><dt className="inline text-fg-3">프로세스 상태 </dt><dd className="inline">{runtime}</dd></div>
      <div><dt className="inline text-fg-3">최근 실행 / 성공 </dt><dd className="inline">{job?.lastRun ?? "없음"} / {job?.lastSuccess ?? "없음"}</dd></div>
      <div><dt className="inline text-fg-3">다음 예약 </dt><dd className="inline">{job?.next ?? "미확인"} · {job?.schedule ?? "1분마다"} · {job?.role ?? "담당 역할 미확인"}</dd></div>
      <div><dt className="inline text-fg-3">처리 줄 </dt><dd className="inline">{job?.lane ?? "미확인"}</dd></div>
    </dl>
    <div className="mt-3 flex flex-wrap items-center gap-3 text-[13px]">
      <Link href={jobHref(JOB)} prefetch={false}>번역 작업 자세히 →</Link>
      {owners && <WorkOwnerButtons owners={owners} title="제품 소개 한국어 번역" />}
    </div>
  </section>;
}
