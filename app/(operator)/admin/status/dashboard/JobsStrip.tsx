'use client';
import { JOB_LABELS } from "@/lib/operations/contracts";
import { formatAgo } from "@/lib/format/time";
import { StatusDot } from "../../components/StatusDot";
import type { OperationJob } from "../OperationsCenter";
import { jobLateness } from "../job-lateness";

const TONE = { ok: "ok", delayed: "warn", failed: "bad", idle: undefined } as const;

/**
 * 작업 생존 띠 — 잡 하나가 칩 하나. 마지막 실행이 주기의 2배를 넘으면 지연(주황 ▲), 5배를 넘으면 크게 지연·오류면 실패(빨강 ■).
 * 규칙은 작업 흐름 탭·진단 표와 같은 jobLateness 하나다(job-lateness.ts).
 * 색만으로 가르지 않는다 — 점 모양과 읽히는 상태 글자가 함께 바뀐다(ADM-31).
 *
 * "지금 돌고 있나"를 한 줄에서 본다. 표 세 벌(오른쪽 표·작업 흐름 탭·접힌 표)에 흩어져 있던 것을 줄였다.
 */
export function JobsStrip({ jobs, now, onOpen }: { jobs: OperationJob[]; now: string; onOpen: (job: OperationJob) => void }) {
  return (
    <section className="dash-card dash-12" aria-label="작업 생존">
      <div className="dash-card-h"><h2>작업 · 마지막 실행</h2><small>주기의 2배를 넘으면 지연 ▲, 5배를 넘으면 크게 지연 ■, 오류면 실패 ■ · 누르면 상세</small></div>
      <div className="dash-jobs">
        {jobs.filter((job) => job.name !== "heartbeat").map((job) => {
          const late = jobLateness(job, now);
          return (
            <button type="button" key={job.name} className="dash-job" data-tone={TONE[late.state]} onClick={() => onOpen(job)} title={`${job.name} · ${job.status} · ${late.text}`}>
              <StatusDot state={late.state} label={JOB_LABELS[job.name] ?? job.name} />
              <small>{late.kind === "paused" ? "멈춤" : job.lastRunAt ? formatAgo(job.lastRunAt, now) : "—"}</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}
