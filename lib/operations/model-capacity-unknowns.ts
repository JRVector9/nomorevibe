import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';

const label = z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:@+/-]+$/);
export const capacityUnknownSchema = z.object({ requestId: z.uuid(), routeId: label, groupId: label,
  oldPolicy: z.boolean(), localEndRecorded: z.boolean() }).strict();
export const capacityUnknownReportSchema = z.object({ status: z.enum(['ok', 'alarm', 'unknown']), truncated: z.boolean(),
  requests: z.array(capacityUnknownSchema).max(64) }).strict().refine(value =>
  value.status === 'alarm' ? value.requests.length > 0 || value.truncated : value.requests.length === 0 && !value.truncated);
export type CapacityUnknownReport = z.infer<typeof capacityUnknownReportSchema>;
export const unknownCapacityReport = (): CapacityUnknownReport => ({ status: 'unknown', truncated: false, requests: [] });

/** Bounded primary SELECT. A pause, policy revision or new successful work cannot hide an unresolved physical call. */
export async function readModelCapacityUnknowns(): Promise<CapacityUnknownReport> {
  if (currentReplayDb()) return unknownCapacityReport();
  try {
    return await onPrimary(() => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      const rows = await tx.execute<{ request_id: string; route_id: string; group_id: string; old_policy: boolean; local_end_recorded: boolean }>(sql`
        SELECT r.request_id::text, r.route_id, r.group_id,
          (r.epoch <> c.epoch OR r.revision <> c.revision OR r.policy_hash IS DISTINCT FROM c.policy_hash) AS old_policy,
          EXISTS (SELECT 1 FROM model_capacity_events e WHERE e.request_id = r.request_id AND e.kind = 'dispatch_local_ended'
            AND e.evidence->'owner'->>'instanceId' = r.owner_instance_id
            AND e.evidence->'owner'->>'bootId' = r.owner_boot_id::text
            AND e.evidence->>'bindingHash' IS NOT DISTINCT FROM r.dispatch_binding_hash) AS local_end_recorded
        FROM model_capacity_requests r CROSS JOIN model_capacity_control c
        WHERE c.id = 1 AND r.state = 'indeterminate' ORDER BY r.queue_ordinal LIMIT 65`);
      // Missing control must not look like an empty queue.
      const control = await tx.execute(sql`SELECT id FROM model_capacity_control WHERE id = 1`);
      if (control.length !== 1) return unknownCapacityReport();
      const requests = Array.from(rows).slice(0, 64).map(row => capacityUnknownSchema.parse({ requestId: row.request_id,
        routeId: row.route_id, groupId: row.group_id, oldPolicy: row.old_policy, localEndRecorded: row.local_end_recorded }));
      return { status: rows.length ? 'alarm' : 'ok', truncated: rows.length > 64, requests };
    }, { accessMode: 'read only', isolationLevel: 'repeatable read' }));
  } catch { return unknownCapacityReport(); }
}
