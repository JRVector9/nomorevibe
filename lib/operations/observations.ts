import { db } from '@/lib/db';
import { operationsObservations } from '@/lib/db/schema';
import { serviceObservationKey, type ServiceRole } from './instance';
export async function observe(key: string, value: Record<string, unknown>) {
  const observedAt = new Date();
  await db.insert(operationsObservations).values({ key, value, observedAt })
    .onConflictDoUpdate({ target: operationsObservations.key, set: { value, observedAt } });
}

export function observeService(role: ServiceRole, value: Record<string, unknown>) {
  return observe(serviceObservationKey(role), value);
}
