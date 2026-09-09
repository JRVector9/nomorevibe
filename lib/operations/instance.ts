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
