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
    // 부팅 기록은 1시간 둔다 — 5분 안 세 번(반복 재시작)만 세면 20분 사이 두 번 죽은 발행 워커가 화면에 남지 않았다(2026-10-08)
    const cutoff = observedAt.getTime() - 5 * 60_000, hourCutoff = observedAt.getTime() - 60 * 60_000;
    const history = (Array.isArray(previous.value.recentBoots) ? previous.value.recentBoots : []).filter(
      (item): item is { id: string; at: number; release?: string } => typeof item?.id === 'string' &&
        typeof item?.at === 'number' && item.at >= hourCutoff,
    );
    if (!history.length && typeof previous.value.bootId === 'string' &&
        typeof previousStarted === 'number' && previousStarted >= hourCutoff) {
      history.push({ id: previous.value.bootId, at: previousStarted,
        ...(typeof previous.value.release === 'string' ? { release: previous.value.release } : {}) });
    }
    if (!history.some(item => item.id === bootId) && bootedAt >= hourCutoff) {
      history.push({ id: bootId, at: bootedAt, ...(typeof value.release === 'string' ? { release: value.release } : {}) });
    }
    const boots = history.sort((a, b) => a.at - b.at).slice(-50);
    // 같은 릴리스로 다시 뜬 것만 센다 — 릴리스가 바뀐 재시작은 배포다
    const restartCount1h = boots.filter((item, i) => i > 0 && item.release !== undefined && item.release === boots[i - 1].release).length;
    await tx.update(operationsObservations).set({
      value: { ...value, recentBoots: boots, restartCount5m: Math.max(0, boots.filter(item => item.at >= cutoff).length - 1), restartCount1h },
      observedAt,
    }).where(eq(operationsObservations.key, key));
  });
}
