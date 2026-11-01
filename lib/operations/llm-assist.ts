import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export type AssistQueueStatus = { task: string; state: string; count: number; mode: string;
  confirmationRequired: boolean; dispatchEnabled: boolean; applyEnabled: boolean; originJob?: string };
export type AssistControlStatus = { task: string; mode: string; confirmationRequired: boolean; dispatchEnabled: boolean; applyEnabled: boolean };
/** 기존 작업과 같은 공통 큐의 실제 상태를 센다. 로컬 timeout을 완료로 표시하지 않는다. */
export async function readAssistQueueStatus(): Promise<AssistQueueStatus[]> {
  return db.execute<AssistQueueStatus>(sql`select w.task,w.state,count(*)::int as count,c.mode,w.origin_job as "originJob",
    c.confirmation_required as "confirmationRequired",c.dispatch_enabled as "dispatchEnabled",c.apply_enabled as "applyEnabled"
    from llm_assist_work w join llm_assist_controls c on c.task=w.task where w.state not in ('done','obsolete')
    group by w.task,w.state,w.origin_job,c.mode,c.confirmation_required,c.dispatch_enabled,c.apply_enabled`);
}

/** 확인 소비·적용 스위치. 대기 작업이 없어도 켜짐 여부를 읽는다. */
export async function readAssistControls(): Promise<AssistControlStatus[]> {
  return db.execute<AssistControlStatus>(sql`select task, mode,
    confirmation_required as "confirmationRequired", dispatch_enabled as "dispatchEnabled", apply_enabled as "applyEnabled"
    from llm_assist_controls order by task`);
}
