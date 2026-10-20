import { consumerOfInstance } from "@/lib/runtime/consumer-registry";

export const SERVICE_ROLES = [
  "app",
  "scheduler",
  "crawler",
  "reviewer",
  "publisher",
  "text",
  "maintenance",
  "connect-agent",
  "translation", "product-health", "site-evidence", "official-news",
] as const;

export type ServiceRole = (typeof SERVICE_ROLES)[number];
type InstanceEnvironment = Readonly<Record<string, string | undefined>>;

const INSTANCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/;

function isServiceRole(value: string): value is ServiceRole {
  return SERVICE_ROLES.includes(value as ServiceRole);
}

export function serviceInstanceId(env: InstanceEnvironment = process.env): string | null {
  const value = env.SERVICE_INSTANCE_ID?.trim();
  if (!value) return null;
  if (!INSTANCE_ID.test(value)) {
    throw new Error("Invalid SERVICE_INSTANCE_ID: expected 1..48 letters, numbers, dot, underscore, or dash");
  }
  return value;
}

export function serviceObservationKey(
  role: ServiceRole,
  env: InstanceEnvironment = process.env,
): string {
  const instanceId = serviceInstanceId(env);
  if (role === "scheduler" && env.SCHEDULER_REPLICA_IDENTITY === "1") {
    const hostname = env.HOSTNAME?.trim();
    if (!hostname || !INSTANCE_ID.test(hostname)) {
      throw new Error("Invalid HOSTNAME for scheduler replica identity");
    }
    return `service:scheduler:${(instanceId ?? "scheduler").slice(0, 35)}-${hostname.slice(0, 12)}`;
  }
  return instanceId ? `service:${role}:${instanceId}` : role;
}

export function parseServiceObservationKey(
  key: string,
): { role: ServiceRole; instanceId: string } | null {
  if (isServiceRole(key)) return { role: key, instanceId: "legacy" };
  const match = /^service:([^:]+):([^:]+)$/.exec(key);
  if (!match || !isServiceRole(match[1]) || !INSTANCE_ID.test(match[2])) return null;
  return { role: match[1], instanceId: match[2] };
}

export function serviceInstancesFromObservations<
  T extends { key: string; value: Record<string, unknown>; observedAt: unknown },
>(rows: T[]): Array<T & { role: ServiceRole; instanceId: string }> {
  const instances = rows.flatMap((row) => {
    const parsed = parseServiceObservationKey(row.key);
    return parsed ? [{ ...row, ...parsed }] : [];
  });
  const scopedRoles = new Set(instances.filter((row) => row.instanceId !== 'legacy').map((row) => row.role));
  return instances.filter((row) => row.instanceId !== 'legacy' || !scopedRoles.has(row.role));
}

/**
 * consumer(건 단위 일꾼, 예: ai1-consumer-m3)는 부모 역할 키(service:<role>:<name>-consumer-*)로 관측되지만 역할 lease 를 갖지 않는다.
 * 그 관측은 역할 생존의 근거가 아니다 — 역할 워커가 죽어도 consumer 가 살아 있으면 역할이 살아 보이면 안 된다.
 */
export function isConsumerServiceInstance(instanceId: string | undefined): boolean {
  return consumerOfInstance(instanceId) !== null;
}

/**
 * 운영센터 역할 칸(대수·'관측 지연'·상세)에 세는 그 역할의 인스턴스. consumer 는 역할 자리가 아니라 빼고 consumerServiceGroups 로 따로 보인다 —
 * 섞이면 consumer 를 멈출 때 역할이 '일부 관측 지연'(오탐)이 되고, 역할 워커가 죽어도 consumer 가 살아 있으면 덜 심각해 보인다.
 */
export function roleServiceInstances<T extends { role: ServiceRole; instanceId?: string }>(rows: T[], role: string): T[] {
  return rows.filter((row) => row.role === role && !isConsumerServiceInstance(row.instanceId));
}

/** consumer 이름별 관측 요약 — 1시간 안 관측(live)과 그중 45초 안(fresh), 가장 최근 관측 시각. 관측이 없는 consumer 는 빼고 이름순 */
export function consumerServiceGroups<T extends { role: ServiceRole; instanceId?: string; observedAt: unknown }>(
  rows: T[], now: number, liveMs = 3_600_000, freshnessMs = 45_000,
): { consumer: string; role: ServiceRole; live: number; fresh: number; latestAt: string }[] {
  const groups = new Map<string, { consumer: string; role: ServiceRole; live: number; fresh: number; latest: number }>();
  for (const row of rows) {
    const consumer = consumerOfInstance(row.instanceId), at = observedTime(row.observedAt);
    if (!consumer || !Number.isFinite(at) || now - at > liveMs) continue;
    const group = groups.get(consumer) ?? { consumer, role: row.role, live: 0, fresh: 0, latest: at };
    group.live++;
    if (now - at <= freshnessMs) group.fresh++;
    group.latest = Math.max(group.latest, at);
    groups.set(consumer, group);
  }
  return [...groups.values()].sort((a, b) => (a.consumer < b.consumer ? -1 : 1))
    .map(({ latest, ...group }) => ({ ...group, latestAt: new Date(latest).toISOString() }));
}

/** 역할의 가장 최근 관측. 인스턴스 키(service:<role>:<id>)든 예전 키(<role>)든 같이 본다. consumer 인스턴스는 뺀다 */
export function latestServiceInstance<T extends { role: ServiceRole; observedAt: unknown; instanceId?: string }>(
  rows: T[],
  role: ServiceRole,
): T | undefined {
  const time = (row: T) => row.observedAt instanceof Date
    ? row.observedAt.getTime()
    : new Date(row.observedAt as string | number).getTime();
  return rows.filter((row) => row.role === role && !isConsumerServiceInstance(row.instanceId)).sort((a, b) => time(b) - time(a))[0];
}

export function staleServiceInstanceCount<T extends { observedAt: unknown }>(
  rows: T[],
  now: number,
  freshnessMs = 45_000,
): number {
  return rows.filter((row) => {
    const observedAt = row.observedAt instanceof Date
      ? row.observedAt.getTime()
      : new Date(row.observedAt as string | number).getTime();
    return !Number.isFinite(observedAt) || now - observedAt > freshnessMs;
  }).length;
}

/**
 * 같은 시각에 살아 있어야 하는 인스턴스 수. 역할 lease 로 한 곳만 일하는 역할은 1, scheduler 는 복제본 둘
 * (failover-readiness 의 freshReplicas >= 2 와 같은 기준). 웹(app)은 m3·mini 가 서로를 대신하지 않으므로 넣지 않는다.
 */
const LIVE_SLOTS: Partial<Record<ServiceRole, number>> = {
  scheduler: 2, crawler: 1, reviewer: 1, publisher: 1, text: 1, maintenance: 1, "connect-agent": 1,
  translation: 1, "product-health": 1, "site-evidence": 1, "official-news": 1,
};

const observedTime = (value: unknown) => value instanceof Date ? value.getTime() : new Date(value as string | number).getTime();
const knownRelease = (value: Record<string, unknown>) =>
  typeof value.release === "string" && value.release !== "unknown" ? value.release : null;

/** 지금 관측되는 인스턴스가 옛 인스턴스를 이어받았나 — 더 늦게 뜬 boot 이거나, 다른(=지금 배포된) 릴리스다 */
function replaces(live: Record<string, unknown>, old: Record<string, unknown>) {
  const newerBoot = typeof live.bootedAt === "number" && typeof old.bootedAt === "number" && live.bootedAt > old.bootedAt;
  const release = knownRelease(live), previous = knownRelease(old);
  return newerBoot || (release !== null && previous !== null && release !== previous);
}

/**
 * 새 boot·새 릴리스가 이어받아 더는 관측되지 않는 옛 인스턴스(superseded)의 키 — 운영센터의 지연 판정에서 뺀다.
 *
 * 서비스 키는 지워지지 않는다. scheduler 복제본은 컨테이너 이름이 키에 들어가 재배포마다 키가 새로 생기고(운영 66개),
 * 예비가 잠깐 일한 역할은 예비 키가 남는다 — 그 옛 키가 1시간 동안 "일부 관측 지연"을 냈다.
 * 살아 있어야 할 자리(LIVE_SLOTS)보다 지금 관측이 적으면, 모자란 수만큼 가장 최근에 본 옛 인스턴스는 빠진 인스턴스일 수 있어 남긴다.
 * consumer 인스턴스는 역할 자리를 채우지도, 이어받지도, 이어받히지도 않는다(isConsumerServiceInstance).
 */
export function supersededServiceInstanceKeys<T extends { key: string; role: ServiceRole; value: Record<string, unknown>; observedAt: unknown; instanceId?: string }>(
  rows: T[],
  now: number,
  freshnessMs = 45_000,
): Set<string> {
  const superseded = new Set<string>();
  const workers = rows.filter((row) => !isConsumerServiceInstance(row.instanceId));
  for (const role of new Set(workers.map((row) => row.role))) {
    const slots = LIVE_SLOTS[role];
    if (!slots) continue;
    const mine = workers.filter((row) => row.role === role);
    const isFresh = (row: T) => Number.isFinite(observedTime(row.observedAt)) && now - observedTime(row.observedAt) <= freshnessMs;
    const fresh = mine.filter(isFresh);
    const stale = mine.filter((row) => !isFresh(row)).sort((a, b) => (observedTime(b.observedAt) || 0) - (observedTime(a.observedAt) || 0));
    for (const row of stale.slice(Math.max(0, slots - fresh.length))) {
      if (fresh.some((live) => replaces(live.value, row.value))) superseded.add(row.key);
    }
  }
  return superseded;
}
