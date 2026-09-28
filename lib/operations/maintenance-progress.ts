import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

export type MaintenanceUptimeProgress = {
  schedulerScheduled: boolean;
  waiting: boolean;
  oldestMinutes: number | null;
  persistedWithin5m: boolean;
  inBackoff: boolean;
  jobError: boolean;
};

/** A large overdue queue alone is not a stall; a fresh saved ping keeps the role active. */
export function maintenanceUptimeStalled(state: MaintenanceUptimeProgress): boolean {
  return state.schedulerScheduled && state.waiting && (state.oldestMinutes ?? 0) >= 5 &&
    !state.persistedWithin5m && !state.inBackoff && !state.jobError;
}

/** Use the DB clock for both queue age and persisted output age. */
export async function readMaintenanceUptimeProgress(): Promise<Omit<MaintenanceUptimeProgress, 'schedulerScheduled'>> {
  const rows = await db.execute<{
    waiting: boolean; oldest_minutes: number | null; persisted_within_5m: boolean;
    in_backoff: boolean; job_error: boolean;
  }>(sql`
    with due as (
      select coalesce(h.checked_at, p.created_at) as since
        from products p left join product_health h on h.slug = p.slug
       where p.status in ('seeded', 'verified') and p.access_mode = 'website'
         and (h.checked_at is null or h.checked_at < now() - interval '6 hours')
    )
    select exists(select 1 from due) as waiting,
      extract(epoch from (now() - (select min(since) from due))) / 60 as oldest_minutes,
      exists(select 1 from product_health where checked_at > now() - interval '5 minutes') as persisted_within_5m,
      coalesce((select not_before > now() from jobs where name = 'uptime-ping'), false) as in_backoff,
      coalesce((select last_error is not null from jobs where name = 'uptime-ping'), false) as job_error
  `);
  const row = rows[0];
  return { waiting: row.waiting, oldestMinutes: row.oldest_minutes === null ? null : Number(row.oldest_minutes),
    persistedWithin5m: row.persisted_within_5m, inBackoff: row.in_backoff, jobError: row.job_error };
}
