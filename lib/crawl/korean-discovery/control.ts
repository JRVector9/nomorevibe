import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { operationsAudit } from '@/lib/db/schema';
import { adminAuditRow } from '@/lib/operations/admin-log';
import { writerSiteActive } from '@/lib/operations/dr/epoch';

export const KoreanDiscoveryControlInput = z.object({ enabled: z.boolean(), startAt: z.string().datetime().nullable(), epoch: z.number().int().positive() }).strict();

/** Change configuration only; provisioned credentials and an actual Oracle heartbeat are still required. */
export async function saveKoreanDiscoveryControl(raw: unknown, actor: string) {
  const input = KoreanDiscoveryControlInput.parse(raw);
  if (input.enabled && !input.startAt) throw new Error('korean_history_start_missing');
  if (input.startAt && Date.parse(input.startAt) > Date.now()) throw new Error('korean_history_start_future');
  return db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new Error('site_fenced');
    const [current] = await tx.execute<{ enabled: boolean; epoch: number; startAt: string | null }>(sql`
      SELECT enabled,epoch,to_char(start_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt"
      FROM github_ko_discovery_control WHERE id=1 FOR UPDATE`);
    if (!current || current.epoch !== input.epoch) throw new Error('korean_settings_changed');
    const startChanged = (current.startAt ? Date.parse(current.startAt) : null) !== (input.startAt ? Date.parse(input.startAt) : null);
    if (startChanged) {
      const [used] = await tx.execute(sql`SELECT label FROM github_ko_discovery_queries LIMIT 1`);
      if (used) throw new Error('korean_history_already_started');
    }
    await tx.execute(sql`UPDATE github_ko_discovery_control SET enabled=${input.enabled},start_at=${input.startAt}::timestamp,updated_at=now() WHERE id=1`);
    await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: 'korean-discovery-control', target: 'github_ko_discovery_control',
      detail: { before: { enabled: current.enabled, startAt: current.startAt, epoch: current.epoch }, after: { enabled: input.enabled, startAt: input.startAt } } }));
    return { enabled: input.enabled };
  });
}
