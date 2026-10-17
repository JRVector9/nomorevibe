import { z } from "zod";

/**
 * D11(PR15d): 슈퍼바이저가 spawn 의도·그룹 종료를 기록한 owner(instance, boot)를 child 에게만 넘기는 env.
 * child 의 모델 장부 행·HTTP hop 이 같은 owner 로 남아야 그 그룹의 종료(ESRCH) 근거가 그 행을 덮는다.
 * parent 자신의 process.env 에는 넣지 않는다 — 근거 없는 parent 호출이 같은 owner 로 섞이면 그 호출까지 끝났다고 잘못 볼 수 있다.
 * DB 를 읽지 않는 가벼운 모듈이다(기본 비활성 consumer 는 DB·runtime 을 열기 전에 끝난다).
 */
const INSTANCE = "PROCESS_GROUP_OWNER_INSTANCE_ID", BOOT = "PROCESS_GROUP_OWNER_BOOT_ID";
const ownerSchema = z.object({ instanceId: z.string().min(1).max(120)
  .refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), "invalid_identity"), bootId: z.uuid() }).strict();

export function processGroupOwnerEnvironment(value: { instanceId: string; bootId: string }): Record<string, string> {
  const owner = ownerSchema.parse(value);
  return { [INSTANCE]: owner.instanceId, [BOOT]: owner.bootId };
}

/** 기록된 owner 가 바로 이 instance 일 때만 그 boot 를 쓴다. 없거나 다르면 null — 호출자는 새 boot(근거 없는 owner, 회수되지 않음)를 쓴다. */
export function processGroupBootFor(instanceId: string | null | undefined, env: Readonly<Record<string, string | undefined>>): string | null {
  const owner = ownerSchema.safeParse({ instanceId: env[INSTANCE], bootId: env[BOOT] });
  return owner.success && instanceId !== undefined && instanceId !== null && owner.data.instanceId === instanceId ? owner.data.bootId : null;
}

/**
 * PROCESS_GROUP_RECORDING: D11 프로세스 그룹 기록(spawn 전 의도 commit·ESRCH 종료) 스위치. 미설정/`0`=꺼짐, `1`=켜짐, 다른 값은 설정 오류다.
 * 꺼져 있으면 슈퍼바이저는 DB 를 거치지 않고 spawn 한다(8020dca 와 같다). 그 boot 의 장부 행·HTTP hop 은 group 근거가 없어
 * reclaim-report 에서 unproven(`owner_not_opened_before_dispatch`)으로 남는다. 켜지면 기록하지 못할 때 spawn 하지 않는다(fail closed).
 */
export function processGroupRecordingEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.PROCESS_GROUP_RECORDING;
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error("invalid_process_group_recording");
}
