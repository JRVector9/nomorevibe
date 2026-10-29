import { sql, type SQL } from "drizzle-orm";

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

const ACTIVE = sql`r.state IN ('waiting','reserved','dispatched','indeterminate')`;
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
