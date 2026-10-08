import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { pendingTaglines } from '@/lib/crawl/taglines';
import { oldestPendingTranslationMinutes } from '@/lib/crawl/translations';

export type TextProgress = { schedulerScheduled: boolean; oldestReadyMinutes: number | null;
  persistedWithin10m: boolean; inBackoff: boolean; providerError: boolean };

export function textProgressStalled(state: TextProgress): boolean {
  return state.schedulerScheduled && (state.oldestReadyMinutes ?? 0) >= 10 &&
    !state.persistedWithin10m && !state.inBackoff && !state.providerError;
}

/** Text jobs share one serial worker. Any persisted output keeps it alive. */
export async function readTextProgress(): Promise<Omit<TextProgress, 'schedulerScheduled'>> {
  const [translationAge, taglines, rows] = await Promise.all([
    oldestPendingTranslationMinutes(), pendingTaglines(1), db.execute<{
      profile_age: number | null; verify_age: number | null; persisted: boolean;
      in_backoff: boolean; provider_error: boolean;
    }>(sql`
      with active as (
        select p.created_at, sp.product_id, sp.updated_at, sp.error_code, sp.attempts,
          sp.retry_at, sp.needs_refresh, sp.verified_at, sp.verify_attempts,
          sp.verify_retry_at, sp.verify_error, sp.keywords_en, sp.keywords_ko
          from products p left join product_search_profiles sp on sp.product_id = p.id
         where p.status in ('seeded', 'verified')
      )
      -- 기다림은 할 일이 된 시각부터 잰다 — 재시도는 retry_at, 30일 갱신은 updated_at + 30일. 마지막 갱신부터 재면
      -- 막 차례가 된 일이 몇 시간·며칠 기다린 것으로 보여, 1분 주기 잡이 집기 전에 감시가 text 워커를 재시작한다
      select
        (select extract(epoch from (now() - min(case when product_id is null then created_at
            when error_code is not null then greatest(updated_at, retry_at)
            when needs_refresh then updated_at else updated_at + interval '30 days' end))) / 60 from active
          where product_id is null or
            (error_code is not null and attempts < 5 and (retry_at is null or retry_at <= now())) or
            (error_code is null and (needs_refresh or updated_at < now() - interval '30 days'))) as profile_age,
        (select extract(epoch from (now() - min(greatest(updated_at, verify_retry_at)))) / 60 from active
          where product_id is not null and not needs_refresh and error_code is null and verified_at is null
            and jsonb_array_length(keywords_en) + jsonb_array_length(keywords_ko) > 0
            and verify_attempts < 5 and (verify_retry_at is null or verify_retry_at <= now())) as verify_age,
        (exists(select 1 from text_translations where target_lang = 'ko' and updated_at > now() - interval '10 minutes')
          or exists(select 1 from crawl_taglines where written_by is null and updated_at > now() - interval '10 minutes')
          or exists(select 1 from product_search_profiles where generated_at > now() - interval '10 minutes'
            or verified_at > now() - interval '10 minutes'
            or (error_code is not null or verify_error is not null)
              and updated_at > now() - interval '10 minutes')) as persisted,
        coalesce((select bool_and(not_before > now()) from jobs
          where name in ('reason-translate','crawl-tagline','product-search-profile','product-search-verify')
            and requested_version > processed_version), false) as in_backoff,
        exists(select 1 from jobs where name in ('reason-translate','crawl-tagline','product-search-profile','product-search-verify')
          and last_error is not null and last_run_at > now() - interval '10 minutes') as provider_error
    `),
  ]);
  const row = rows[0];
  const taglineAge = taglines[0]?.readyAgeMinutes ?? null;
  const ages = [translationAge, taglineAge, row.profile_age, row.verify_age].filter((n): n is number => n !== null).map(Number);
  return { oldestReadyMinutes: ages.length ? Math.max(...ages) : null,
    persistedWithin10m: row.persisted, inBackoff: row.in_backoff,
    providerError: row.provider_error || !process.env.ABCLLM_API_KEY?.trim() };
}
