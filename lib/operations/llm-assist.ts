import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export type AssistQueueStatus = { task: string; state: string; count: number; mode: string;
  confirmationRequired: boolean; dispatchEnabled: boolean; applyEnabled: boolean };
/** 기존 작업과 같은 공통 큐의 실제 상태를 센다. 로컬 timeout을 완료로 표시하지 않는다. */
export async function readAssistQueueStatus(): Promise<AssistQueueStatus[]> {
  return db.execute<AssistQueueStatus>(sql`select w.task,w.state,count(*)::int as count,c.mode,
    c.confirmation_required as "confirmationRequired",c.dispatch_enabled as "dispatchEnabled",c.apply_enabled as "applyEnabled"
    from llm_assist_work w join llm_assist_controls c on c.task=w.task where w.state not in ('done','obsolete')
    group by w.task,w.state,c.mode,c.confirmation_required,c.dispatch_enabled,c.apply_enabled`);
}
