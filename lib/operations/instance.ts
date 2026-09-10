export const SERVICE_ROLES = [
  "app",
  "scheduler",
  "crawler",
  "reviewer",
  "publisher",
  "maintenance",
  "connect-agent",
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

/** 역할의 가장 최근 관측. 인스턴스 키(service:<role>:<id>)든 예전 키(<role>)든 같이 본다 */
export function latestServiceInstance<T extends { role: ServiceRole; observedAt: unknown }>(
  rows: T[],
  role: ServiceRole,
): T | undefined {
  const time = (row: T) => row.observedAt instanceof Date
    ? row.observedAt.getTime()
    : new Date(row.observedAt as string | number).getTime();
  return rows.filter((row) => row.role === role).sort((a, b) => time(b) - time(a))[0];
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
