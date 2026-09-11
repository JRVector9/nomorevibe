import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { textTranslations } from "@/lib/db/schema";
import { needsKorean, textHash } from "./translate";

/**
 * 번역해 둘 글과 번역해 둔 글.
 *
 * 글이 나오는 곳은 심사 화면에 뜨는 두 가지다 — AI 심사 기록의 사유(reason 이 있으면 그것, 없으면
 * outcome.reason. 화면의 summarizeAttempt 와 같은 순서)와 2차 판단 사유. 같은 글은 한 번만 번역한다.
 * 해시는 DB 에서도 JS 에서도 원문 UTF-8 의 sha256 이라 서로 맞는다.
 */
const SOURCES = sql`
  select coalesce(a.reason, a.outcome->>'reason') as body, coalesce(a.completed_at, a.started_at) as at
    from crawl_review_attempts a where coalesce(a.reason, a.outcome->>'reason') is not null
  union all
  select s.second_reason, coalesce(s.reviewed_at, s.created_at) from second_reviews s where s.second_reason is not null`;

/** translate.ts needsKorean 과 같은 기준 — 글자 중 한글이 30% 미만 */
const NEEDS_KOREAN = sql`length(btrim(body)) > 0 and length(regexp_replace(body, '[^가-힣]', '', 'g'))
  < 0.3 * greatest(1, length(regexp_replace(body, '[^A-Za-z가-힣]', '', 'g')))`;

const UNIQUE_SOURCES = sql`select encode(sha256(convert_to(body, 'UTF8')), 'hex') as hash, body, max(at) as at
  from (${SOURCES}) src where ${NEEDS_KOREAN} group by 1, 2`;

export type PendingTranslation = { hash: string; body: string; attempts: number };

/**
 * 아직 번역이 없는 글 — 최근 것부터. 실패한 것은 다시 볼 때가 된 것만(5분부터 두 배씩).
 * 실패한 것을 뒤로 미루면 몇 시간씩 "실패"로 남는다 — 첫 배포 때 시간 제한 탓에 실패한 39건이
 * 처음 보는 2,300건 뒤에 줄을 섰다. 최근 순서만 따르고, 실패한 글은 작업이 한 건씩 따로 옮긴다.
 */
export async function pendingTranslations(limit: number): Promise<PendingTranslation[]> {
  const rows = await db.execute<{ hash: string; body: string; attempts: number }>(sql`
    select u.hash, u.body, coalesce(t.attempts, 0)::int as attempts
      from (${UNIQUE_SOURCES}) u
      left join ${textTranslations} t on t.source_hash = u.hash and t.target_lang = 'ko'
     where t.source_hash is null or (t.status = 'failed' and (t.retry_at is null or t.retry_at <= now()))
     order by u.at desc nulls last
     limit ${limit}`);
  return [...rows].map((row) => ({ hash: row.hash, body: row.body, attempts: Number(row.attempts) }));
}

/**
 * 결과를 남긴다. 실패는 5분·10분·20분… 뒤에 다시(최대 하루) — 느려도 끝까지 이어 가되
 * 늘 실패하는 한 건이 매 틱을 잡아먹지 않게.
 */
export async function recordTranslations(results: { hash: string; translated: string | null; error?: string }[], model: string): Promise<void> {
  for (const result of results) {
    const done = result.translated !== null;
    await db.insert(textTranslations).values({
      sourceHash: result.hash, targetLang: "ko", status: done ? "done" : "failed", translated: result.translated, model,
      attempts: 1, errorCode: done ? null : (result.error ?? "invalid_output").slice(0, 60),
      retryAt: done ? null : sql`now() + interval '5 minutes'`, updatedAt: sql`now()`,
    }).onConflictDoUpdate({
      target: [textTranslations.sourceHash, textTranslations.targetLang],
      set: done
        ? { status: "done", translated: result.translated, model, errorCode: null, retryAt: null, updatedAt: sql`now()`,
            attempts: sql`${textTranslations.attempts} + 1` }
        : { status: "failed", model, errorCode: (result.error ?? "invalid_output").slice(0, 60), updatedAt: sql`now()`,
            attempts: sql`${textTranslations.attempts} + 1`,
            retryAt: sql`now() + least(interval '24 hours', interval '5 minutes' * power(2, ${textTranslations.attempts}))` },
      // 번역이 이미 있으면 실패로 덮지 않는다
      setWhere: done ? undefined : sql`${textTranslations.status} <> 'done'`,
    });
  }
}

/** 화면에 뜨는 글의 번역 — 원문 → 번역. 번역이 없거나 옮길 필요가 없는 글은 빠진다 */
export async function translationsFor(texts: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = new Map<string, string>();
  for (const text of texts) if (text && needsKorean(text)) wanted.set(textHash(text), text);
  if (!wanted.size) return new Map();
  const rows = await db.select({ hash: textTranslations.sourceHash, translated: textTranslations.translated }).from(textTranslations)
    .where(and(inArray(textTranslations.sourceHash, [...wanted.keys()]), eq(textTranslations.targetLang, "ko"), eq(textTranslations.status, "done")));
  return new Map(rows.flatMap((row) => row.translated ? [[wanted.get(row.hash)!, row.translated] as const] : []));
}

export type TranslationProgress = { total: number; done: number; failed: number; pending: number; lastHour: number; lastSecondsAgo: number | null };

/** 운영센터가 보여 주는 진행 — 옮길 글(같은 글은 하나) 중 몇 개를 옮겼나 */
export async function translationProgress(): Promise<TranslationProgress> {
  const [row] = [...await db.execute<{ total: number; done: number; failed: number; last_hour: number; last_ago: number | null }>(sql`
    select count(*)::int as total,
           (count(*) filter (where t.status = 'done'))::int as done,
           (count(*) filter (where t.status = 'failed'))::int as failed,
           (select count(*)::int from ${textTranslations} where status = 'done' and updated_at > now() - interval '1 hour') as last_hour,
           (select extract(epoch from now() - max(updated_at))::int from ${textTranslations} where status = 'done') as last_ago
      from (${UNIQUE_SOURCES}) u
      left join ${textTranslations} t on t.source_hash = u.hash and t.target_lang = 'ko'`)];
  const total = Number(row?.total ?? 0), done = Number(row?.done ?? 0);
  return { total, done, failed: Number(row?.failed ?? 0), pending: total - done, lastHour: Number(row?.last_hour ?? 0),
    lastSecondsAgo: row?.last_ago === null || row?.last_ago === undefined ? null : Number(row.last_ago) };
}
