import { sql, type SQL } from "drizzle-orm";
import { liveStateSql } from "./capacity-states";
import type { ModelCapacityRequest, ModelSlotResult } from "./capacity";
import type { ModelCapacityDeferredReason } from "./capacity-deferred";
import { findOwnPendingModelRequest } from "./capacity-repository";

/**
 * 장부가 `capacity` 로 미룬 까닭을 가른다 — 줄에 섰나(포화) 아니면 행 없이 거절됐나(같은 작업 fence·중복 작업). 읽기만 한다.
 *
 * requestSlot(capacity-repository.ts)은 둘 다 `capacity` 로 답한다. 포화면 이 requestId 의 waiting 행이 남아 다음 poll 이 줄 순서를
 * 잇고, fence·중복 작업은 행을 만들지 않는다(awaitQueuedAi1Reservation 의 not_queued 와 같은 판정). 행 없는 거절은 이 작업 하나의 일이라
 * `work_busy` 로 바꾼다 — 호출자는 이 대상만 건너뛰고 모델·틱을 멈추지 않는다(2026-10-30 소유자 결정). 다른 사유는 그대로 돌려준다.
 * 남는 경계: 이미 줄에 선 요청을 다시 묻는 사이 fence 가 생기면 행이 남아 있어 `capacity`(포화)로 본다 — 예전과 같은 동작이다.
 */
export async function capacityRefusalReason(request: ModelCapacityRequest,
  reason: Extract<ModelSlotResult, { kind: "deferred" }>["reason"]): Promise<ModelCapacityDeferredReason> {
  if (reason !== "capacity") return reason;
  const { requestId, ...identity } = request;
  const own = await findOwnPendingModelRequest(identity);
  return own?.requestId === requestId && (own.state === "waiting" || own.state === "reserved") ? "capacity" : "work_busy";
}

/**
 * 요청 장부가 이미 쥔 대상 — 대기열 선택기가 건너뛸 키(읽기만 한다, 승인·해제·만료를 하지 않는다).
 *
 * 세 text 잡(reason-translate·product-tagline-ko·product-search-profile)은 대기열 맨 앞을 정해진 순서로 고른다.
 * 그 대상이 이미 다른 요청(대기·예약·보냄·미확인)에 묶여 있으면 장부의 fence(capacity-repository.ts
 * reasonTranslationFence·productTaglineKoFence·textProfileFence)가 새 요청을 'capacity' 로 미룬다. 미룸은 아무것도 적지 않으므로
 * 다음 틱도 같은 대상을 다시 골라 같은 미룸을 되풀이했다 — 미확인 요청 하나가 잡 전체를 무진척으로 세웠다.
 * 선택기가 fence 와 같은 상태·키를 미리 빼면 맨 앞이 막혀도 그 뒤의 다른 대상이 나간다. fence·용량 한도는 그대로다.
 *
 * keepOwn: 이 프로세스 boot 의 대기·예약 요청은 빼지 않는다 — 조정기가 그 요청을 이어받거나(adopt) 지운다.
 * 운영 모드가 open 일 때만 뺀다. disabled(legacy) 경로에는 fence 가 없다.
 */
export type CapacityOwner = Readonly<{ instanceId: string; bootId: string }>;

// 미확인(indeterminate)은 살아 있는 행이 아니다(capacity-states.ts) — 선택기가 그 대상을 숨기지 않는다.
// 만료된 미전송 행도 숨기지 않는다. 새 boot 가 마지막 일감을 고르지 못하면 requestSlot 의 lazy expiry 에 도달할 수 없다.
// 선택은 읽기만 하고, 실제 만료·중복·소유권 판정은 admission 이 control 잠금 아래 다시 한다. 보낸 요청은 기한으로 빼지 않는다.
// NULL 은 스키마상 waiting.queue_until / reserved.reserved_until 에 올 수 없지만, 읽기 경계에서는 보수적으로 busy 를 유지한다.
const ACTIVE = sql`(${liveStateSql("r.state")}
  AND (r.state <> 'waiting' OR r.queue_until IS NULL OR r.queue_until > clock_timestamp())
  AND (r.state <> 'reserved' OR r.reserved_until IS NULL OR r.reserved_until > clock_timestamp()))`;
const OPEN = sql`EXISTS (SELECT 1 FROM model_capacity_control c WHERE c.id = 1 AND c.mode = 'open')`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownPending(owner: CapacityOwner | undefined): SQL {
  if (!owner || !owner.instanceId || !UUID.test(owner.bootId)) return sql`false`;
  return sql`(r.state IN ('waiting','reserved') AND r.owner_instance_id = ${owner.instanceId} AND r.owner_boot_id = ${owner.bootId}::uuid)`;
}

/** 묶음 요청의 멤버 키(`ko:<hash>`·`product-tagline-ko:<id>`) 중 prefix 로 시작하는 것. SELECT 한 열(key) */
export function busyMemberKeysSql(prefix: string, options: { owner?: CapacityOwner; keepOwn?: boolean } = {}): SQL {
  const keep = options.keepOwn ? ownPending(options.owner) : sql`false`;
  return sql`SELECT DISTINCT member AS key FROM model_capacity_requests r CROSS JOIN LATERAL unnest(r.logical_member_keys) member
    WHERE ${ACTIVE} AND r.logical_member_keys IS NOT NULL AND left(member, ${prefix.length}) = ${prefix}
      AND NOT ${keep} AND ${OPEN}`;
}

/** 한 건 요청의 논리 키(`text:profile:<id>`) 중 prefix 로 시작하는 것. SELECT 한 열(key) */
export function busyLogicalKeysSql(prefix: string, options: { owner?: CapacityOwner; keepOwn?: boolean } = {}): SQL {
  const keep = options.keepOwn ? ownPending(options.owner) : sql`false`;
  return sql`SELECT DISTINCT r.logical_work_key AS key FROM model_capacity_requests r
    WHERE ${ACTIVE} AND left(r.logical_work_key, ${prefix.length}) = ${prefix} AND NOT ${keep} AND ${OPEN}`;
}

/** ROLE_LEASE_* 의 요청 owner(조정기가 쓰는 것과 같은 instance·boot). 없거나 형식이 다르면 undefined — 내 요청도 뺀다 */
export function capacityOwnerFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): CapacityOwner | undefined {
  const instanceId = env.ROLE_LEASE_INSTANCE_ID?.trim(), bootId = env.ROLE_LEASE_BOOT_ID?.trim();
  return instanceId && bootId && UUID.test(bootId) ? { instanceId, bootId } : undefined;
}

// 2026-10-31(PR 3a-B): `otherRoutesWaitingOnGroup`(같은 장비의 다른 route 대기를 보고 일꾼을 줄이던 양보)은 없앴다 — 단계는 다른 단계의
// 실시간 상태를 보지 않는다. 장비 나눔은 장비 순위(PR 1b model_capacity_device_roles·secondaryCap·reserve)가 입장 TX 에서 정한다.
