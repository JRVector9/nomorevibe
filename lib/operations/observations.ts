import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { operationsObservations } from '@/lib/db/schema';
import { serviceObservationKey, type ServiceRole } from './instance';
export async function observe(key: string, value: Record<string, unknown>) {
  const observedAt = new Date();
  await db.insert(operationsObservations).values({ key, value, observedAt })
    .onConflictDoUpdate({ target: operationsObservations.key, set: { value, observedAt } });
}

export function observeService(role: ServiceRole, value: Record<string, unknown>) {
  const key = serviceObservationKey(role);
  const bootId = value.bootId;
  const bootedAt = value.bootedAt;
  if (typeof bootId !== 'string' || typeof bootedAt !== 'number') return observe(key, value);
  return db.transaction(async tx => {
    const observedAt = new Date();
    await tx.insert(operationsObservations).values({ key, value, observedAt }).onConflictDoNothing();
    const [previous] = await tx.select().from(operationsObservations)
      .where(eq(operationsObservations.key, key)).for('update');
    const previousStarted = previous.value.bootedAt;
    if (typeof previousStarted === 'number' && previousStarted > bootedAt) return;
    const cutoff = observedAt.getTime() - 5 * 60_000;
    const history = (Array.isArray(previous.value.recentBoots) ? previous.value.recentBoots : []).filter(
      (item): item is { id: string; at: number } => typeof item?.id === 'string' &&
        typeof item?.at === 'number' && item.at >= cutoff,
    );
    if (!history.length && typeof previous.value.bootId === 'string' &&
        typeof previousStarted === 'number' && previousStarted >= cutoff) {
      history.push({ id: previous.value.bootId, at: previousStarted });
    }
    if (!history.some(item => item.id === bootId) && bootedAt >= cutoff) {
      history.push({ id: bootId, at: bootedAt });
    }
    await tx.update(operationsObservations).set({
      value: { ...value, recentBoots: history, restartCount5m: Math.max(0, history.length - 1) }, observedAt,
    }).where(eq(operationsObservations.key, key));
  });
}
