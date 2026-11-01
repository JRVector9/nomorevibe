import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { pendingTaglines } from '@/lib/crawl/taglines';
import { oldestPendingTranslationMinutes } from '@/lib/crawl/translations';
import { getSettings, settingsUnreadable } from '@/lib/crawl/settings';
import { profileGenerationRetryAllowedSql } from '@/lib/domain/products/search-profile-retry';
import { readModelCapacityCallerControl } from '@/lib/llm/capacity-repository';
import { ensureServingContracts, textRouteCallable } from '@/lib/llm/serving-contract-store';
import { currentModelEnv } from '@/lib/operations/model-env';

export type TextProgress = { schedulerScheduled: boolean; oldestReadyMinutes: number | null;
  persistedWithin10m: boolean; inBackoff: boolean; providerError: boolean; admissionHeld: boolean };

export function textProgressStalled(state: TextProgress): boolean {
  return state.schedulerScheduled && (state.oldestReadyMinutes ?? 0) >= 10 &&
    !state.persistedWithin10m && !state.inBackoff && !state.providerError && !state.admissionHeld;
}

type MainTextRoute = 'reason-translate' | 'crawl-tagline' | 'product-search-profile' | 'product-search-verify';

/**
 * Which main text routes can call their model: a directly connected engine contract (admin, transport direct) for the route's
 * model — any of the stored admin stage pool's models, else this process's configured one. The abcLLM gateway is gone, so a route
 * without one is not running, and its queue is a configuration gap the job already reports (degraded), not a stall to restart.
 */
async function callableMainTextRoutes(): Promise<Record<MainTextRoute, boolean>> {
  await ensureServingContracts();
  const models = await currentModelEnv();
  const callable = (route: MainTextRoute, model: string) => (models.pooled?.[route]?.length ? models.pooled[route] : [model])
    .some(name => textRouteCallable(route, name));
  return { 'reason-translate': callable('reason-translate', models.translate), 'crawl-tagline': callable('crawl-tagline', models.tagline),
    'product-search-profile': callable('product-search-profile', models.profile), 'product-search-verify': callable('product-search-verify', models.verify) };
}

/** Persisted progress of the serial main text jobs; product translation runs in a separate runtime lane. */
export async function readTextProgress(): Promise<Omit<TextProgress, 'schedulerScheduled'>> {
  const [callable, settings, capacity, translationAge, taglines, rows] = await Promise.all([
    callableMainTextRoutes(), getSettings(), readModelCapacityCallerControl(),
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
            (error_code is not null and ${profileGenerationRetryAllowedSql(sql`error_code`, sql`attempts`)}
              and (retry_at is null or retry_at <= now())) or
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
  // A malformed settings fallback is unknown, not proof that an operator paused collection.
  if (settingsUnreadable(settings)) throw new Error('crawl_settings_unreadable');
  const row = rows[0];
  // Collection pauses only crawl-tagline. Translation and keyword jobs still admit work.
  const taglineAge = settings.enabled ? taglines[0]?.readyAgeMinutes ?? null : null;
  // A route without a direct contract is not running; its queue cannot prove the worker stuck (restarting would not help).
  const ages = [callable['reason-translate'] ? translationAge : null, callable['crawl-tagline'] ? taglineAge : null,
    callable['product-search-profile'] ? row.profile_age : null, callable['product-search-verify'] ? row.verify_age : null]
    .filter((n): n is number => n !== null).map(Number);
  return { oldestReadyMinutes: ages.length ? Math.max(...ages) : null,
    persistedWithin10m: row.persisted, inBackoff: row.in_backoff,
    providerError: row.provider_error,
    // Only drain blocks all model admission; disabled retains the existing legacy transport.
    admissionHeld: capacity.mode === 'draining' };
}
