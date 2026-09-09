import { db } from '@/lib/db';
import { operationsObservations } from '@/lib/db/schema';
export async function observe(key: string, value: Record<string, unknown>) {
  await db.insert(operationsObservations).values({ key, value, observedAt: new Date() })
    .onConflictDoUpdate({ target: operationsObservations.key, set: { value, observedAt: new Date() } });
}
