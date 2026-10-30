import { sql, type SQL } from "drizzle-orm";
import { liveStateSql } from "./capacity-states";
import { db } from "@/lib/db";

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
const ACTIVE = liveStateSql("r.state");
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

/**
 * 같은 물리 그룹(정책 route 의 groupId)에서 다른 route 의 대기 요청이 살아 있는가 — 읽기만 한다.
 *
 * 장부는 같은 class 안에서 먼저 온 대기부터 준다. 한 잡이 그룹의 동시 수만큼 일꾼을 돌려 자리가 나는 즉시 다음 요청을 넣으면
 * 같은 그룹의 다른 잡(기본 등록부에서 product-search-profile·product-tagline-ko 는 같은 gpt-oss 모델)은 미룸만 받는다. 남이 기다리면
 * 이번 묶음은 일꾼 하나로 줄여 자리를 나눈다. 장부의 한도·순서는 바꾸지 않는다. 읽지 못하면 false(전과 같은 동작)다.
 */
export async function otherRoutesWaitingOnGroup(routeId: string, model: string): Promise<boolean> {
  try {
    const [row] = await db.execute<{ waiting: boolean }>(sql`SELECT EXISTS (
      SELECT 1 FROM model_capacity_control c
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.policy->'routes', '[]'::jsonb)) route
        JOIN model_capacity_requests r ON r.group_id = route->>'groupId'
      WHERE c.id = 1 AND c.mode = 'open' AND route->>'routeId' = ${routeId} AND route->>'model' = ${model}
        AND r.route_id <> ${routeId} AND r.state = 'waiting' AND r.queue_until > clock_timestamp()
        AND r.epoch = c.epoch AND r.revision = c.revision AND r.policy_hash = c.policy_hash) AS waiting`);
    return row?.waiting === true;
  } catch { return false; }
}
