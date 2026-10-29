// Read-only AI1 rule-shadow sample. AI agreement is not human-verified rule accuracy.
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10, prepare: false });
try {
  const result = await sql.begin('read only', async tx => {
    await tx`SET LOCAL statement_timeout = '25s'`;
    const clock = await tx`SELECT now() measured_at, pg_is_in_recovery() replica`;
    const quality = await tx`WITH ai1 AS (
      SELECT id, input_hash, outcome->>'decision' decision, snapshot FROM crawl_review_attempts
      WHERE kind='automatic' AND state='succeeded' AND provider<>'rules' AND reused_from_attempt_id IS NULL
        AND prompt_version='2026-10-06.2' AND completed_at>now()-interval '14 days')
      SELECT threshold, count(*)::int n,
        count(*) FILTER (WHERE char_length(coalesce(snapshot->'product'->>'pageText',''))<threshold)::int triggered,
        count(*) FILTER (WHERE char_length(coalesce(snapshot->'product'->>'pageText',''))<threshold AND decision='reject')::int ai_reject,
        count(*) FILTER (WHERE char_length(coalesce(snapshot->'product'->>'pageText',''))<threshold AND decision='approve')::int ai_approve,
        count(*) FILTER (WHERE char_length(coalesce(snapshot->'product'->>'pageText',''))<threshold AND decision='needs_review')::int ai_hold
      FROM ai1 CROSS JOIN (VALUES(50),(100),(200),(400)) thresholds(threshold) GROUP BY threshold ORDER BY threshold`;
    const byMode = await tx`SELECT coalesce(snapshot->'product'->>'accessMode','unknown') mode,
      count(*)::int n,
      count(*) FILTER (WHERE char_length(coalesce(snapshot->'product'->>'pageText',''))<200)::int triggered,
      count(*) FILTER (WHERE char_length(coalesce(snapshot->'product'->>'pageText',''))<200 AND outcome->>'decision'='reject')::int ai_reject,
      count(*) FILTER (WHERE char_length(coalesce(snapshot->'product'->>'pageText',''))<200 AND outcome->>'decision'='approve')::int ai_approve
      FROM crawl_review_attempts WHERE kind='automatic' AND state='succeeded' AND provider<>'rules' AND reused_from_attempt_id IS NULL
        AND prompt_version='2026-10-06.2' AND completed_at>now()-interval '14 days' GROUP BY 1 ORDER BY 1`;
    const stored = await tx`SELECT 'ai1' stage, count(*)::int total, max(completed_at) latest
      FROM crawl_review_attempts WHERE kind='automatic' AND state='succeeded' AND provider<>'rules' AND reused_from_attempt_id IS NULL
      UNION ALL SELECT 'ai2', count(*)::int, max(reviewed_at) FROM second_reviews
      WHERE second_decision IS NOT NULL AND reviewed_at IS NOT NULL`;
    return { clock, quality, byMode, stored };
  });
  console.log(JSON.stringify(result));
} catch (e) {
  console.error(JSON.stringify({ error: e.code ?? e.name, message: e.message }));
  process.exitCode = 1;
} finally { await sql.end({ timeout: 2 }); }
