'use client';
import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { JOB_LABELS } from "@/lib/operations/contracts";
import { formatAgo } from "@/lib/format/time";
import { StatusDot } from "../../components/StatusDot";
import type { OperationJob } from "../OperationsCenter";

/**
 * 작업 생존 띠 — 잡 하나가 칩 하나. 마지막 실행이 주기의 2배를 넘으면 지연(주황 ▲), 5배를 넘거나 오류면 실패(빨강 ■).
 * 색만으로 가르지 않는다 — 점 모양과 읽히는 상태 글자가 함께 바뀐다(ADM-31).
 *
 * "지금 돌고 있나"를 한 줄에서 본다. 표 세 벌(오른쪽 표·작업 흐름 탭·접힌 표)에 흩어져 있던 것을 줄였다.
 */
export function JobsStrip({ jobs, now, onOpen }: { jobs: OperationJob[]; now: string; onOpen: (job: OperationJob) => void }) {
  const at = new Date(now).getTime();
  const ago = (value: string | null) => value
    ? { seconds: Math.max(0, Math.round((at - new Date(value).getTime()) / 1000)), text: formatAgo(value, now) }
    : { text: "—", seconds: Number.POSITIVE_INFINITY };
  return (
    <section className="dash-card dash-12" aria-label="작업 생존">
      <div className="dash-card-h"><h2>작업 · 마지막 실행</h2><small>주기의 2배를 넘으면 지연, 5배 또는 오류면 실패 · 누르면 상세</small></div>
      <div className="dash-jobs">
        {jobs.filter((job) => job.name !== "heartbeat").map((job) => {
          const interval = JOB_CATALOG.find((entry) => entry.name === job.name)?.intervalMs ?? null;
          const paused = job.notBefore && new Date(job.notBefore).getTime() > at + 365 * 86400_000;
          const last = ago(job.lastRunAt);
          const tone = job.lastError ? "bad" : paused ? undefined : interval && last.seconds > (interval / 1000) * 5 ? "bad" : interval && last.seconds > (interval / 1000) * 2 ? "warn" : "ok";
          const state = tone === "bad" ? "failed" : tone === "warn" ? "delayed" : tone === "ok" ? "ok" : "idle";
          return (
            <button type="button" key={job.name} className="dash-job" data-tone={tone} onClick={() => onOpen(job)} title={`${job.name} · ${job.status}`}>
              <StatusDot state={state} label={JOB_LABELS[job.name] ?? job.name} />
              <small>{paused ? "멈춤" : last.text}</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}
