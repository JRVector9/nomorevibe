import Link from "next/link";
import type { AssistControlStatus, AssistQueueStatus } from "@/lib/operations/llm-assist";
import { jobHref } from "../action-links";

const TASK_LABEL: Record<string, string> = { uptime: "접속 실패 확인" };
const STATE_LABEL: Record<string, string> = {
  queued: "모델에 묻기 전",
  claimed: "확인 중",
  waiting_evidence: "페이지 근거 대기",
  waiting_capacity: "모델 용량 대기",
  retryable_transport: "다시 연결 대기",
  human: "사람 확인",
  indeterminate: "결과 미확정",
};
const n = (value: number) => value.toLocaleString("ko-KR");

function SwitchFace({ on, title, detail }: { on: boolean; title: string; detail: string }) {
  return (
    <div className="confirm-switch" data-on={on ? "true" : "false"}>
      <span className="ops-collection" data-on={on || undefined}>
        <span aria-hidden className="ops-collection-track"><span /></span>
      </span>
      <span>
        <b>{title}</b>
        <small>{on ? "켜짐" : "꺼짐"}. {detail}</small>
      </span>
    </div>
  );
}

/** 업타임 LLM 확인의 두 설정. 보이는 상태만 보여 주고, 여기서 켜거나 끄지는 않는다. */
export function UptimeConfirmControls({ controls, queue }: {
  controls: AssistControlStatus[] | null | undefined;
  queue: AssistQueueStatus[] | null | undefined;
}) {
  if (controls == null || queue == null) {
    return <section id="uptime-confirm" className="dash-card dash-12" aria-label="업타임 LLM 확인">
      <div className="dash-card-h"><h2>업타임 LLM 확인</h2></div>
      <p className="dash-note">확인 소비·적용 설정을 읽지 못했습니다. 대기 없음으로 보지 않습니다.</p>
    </section>;
  }
  const required = controls.filter((row) => row.confirmationRequired);
  return <section id="uptime-confirm" className="dash-card dash-12" aria-label="업타임 LLM 확인">
    <div className="dash-card-h"><h2>업타임 LLM 확인</h2><small>보이는 상태</small></div>
    <p className="dash-note">사이트가 죽은 것 같은 제품은 바로 내리지 않고, 모델 확인을 기다립니다. 두 설정은 하는 일이 다릅니다.</p>
    {required.length === 0 ? <p className="dash-note">확인이 필수인 업무가 없습니다.</p> : required.map((control) => {
      const rows = queue.filter((row) => row.task === control.task);
      const waiting = rows.reduce((total, row) => total + row.count, 0);
      return <div key={control.task} className="mt-3">
        <p className="text-[13px] font-semibold">{TASK_LABEL[control.task] ?? control.task}</p>
        <div className="confirm-switches">
          <SwitchFace on={control.dispatchEnabled} title="확인 소비" detail="켜면 대기 후보를 모델에 묻습니다. 제품은 내리지 않습니다." />
          <SwitchFace on={control.applyEnabled} title="적용" detail="켜면 모델이 죽었다고 한 제품을 공개 목록에서 내립니다." />
        </div>
        <p className="dash-note">대기 {n(waiting)}건{rows.length ? ` · ${rows.map((row) => `${STATE_LABEL[row.state] ?? row.state} ${n(row.count)}`).join(" · ")}` : ""}.</p>
      </div>;
    })}
    <div className="mt-3 text-[13px]"><Link href={jobHref("product-llm-assist-review")} prefetch={false}>보강 소비자 작업 →</Link></div>
  </section>;
}
