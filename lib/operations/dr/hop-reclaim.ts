import { z } from "zod";
import { identity, isoMillis } from "./epoch";

/**
 * PR15d HTTP hop 회수 근거(0099 http_origin_events.evidence, released 사건에만). HTTP origin 은 client_bound 다: hop 을 dispatch 한 프로세스가
 * 속한 그룹 전체가 사라졌으면(그 owner 의 dispatch 시각까지 의도가 기록된 모든 child 의 ESRCH) 우리 쪽 요청 소켓도 남지 않는다.
 * 시간 경과(TTL)·heartbeat 부재는 근거 kind 가 아니다. 시각은 회수 TX 의 DB clock 이고 저장된 JSON 은 권한이 아니다.
 */
export const httpHopReleaseEvidenceSchema = z.object({ version: z.literal(1), kind: z.literal("process_group_exit"), hopId: z.uuid(),
  owner: z.object({ instanceId: identity(120), bootId: z.uuid() }).strict(), fromState: z.enum(["dispatched", "indeterminate"]), dispatchAt: isoMillis,
  termination: z.literal("client_bound"), skewBoundMs: z.number().int().min(1).max(600_000), reference: identity(400),
  exits: z.array(z.object({ seq: z.number().int().min(1).max(2147483647), runId: z.uuid(), pid: z.number().int().min(2).max(2147483647), exitedAt: isoMillis }).strict())
    .min(1).max(4096), notBefore: isoMillis, evaluatedAt: isoMillis, operator: identity(120) }).strict()
  .refine(value => value.dispatchAt <= value.notBefore && value.notBefore <= value.evaluatedAt, "hop_release_not_due");
export type HttpHopReleaseEvidence = Readonly<z.infer<typeof httpHopReleaseEvidenceSchema>>;
