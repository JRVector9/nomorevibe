// Run inside an existing worker image with its DATABASE_URL. All queries are read-only.
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10, prepare: false });
try {
  const result = await sql.begin('read only', async tx => {
    await tx`SET LOCAL statement_timeout = '25s'`;
    const clock = await tx`SELECT now() measured_at, pg_is_in_recovery() replica`;
    const latency = await tx`SELECT r.route_id, r.model, r.provider_budget_id, count(*)::int n,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (s.created_at-r.dispatched_at))) p95,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (s.created_at-r.dispatched_at))) p99,
      max(extract(epoch FROM (s.created_at-r.dispatched_at))) max_s
      FROM model_capacity_requests r JOIN model_capacity_events s ON s.request_id=r.request_id AND s.kind='dispatch_settled'
      WHERE r.dispatched_at>now()-interval '7 days' GROUP BY 1,2,3 ORDER BY 1,2`;
    const stored = await tx`SELECT 'ai1' stage, count(*)::int total, max(completed_at) latest,
      count(*) FILTER (WHERE completed_at>now()-interval '60 minutes')::int last_hour
      FROM crawl_review_attempts WHERE kind='automatic' AND state='succeeded' AND provider<>'rules' AND reused_from_attempt_id IS NULL
      UNION ALL SELECT 'ai2', count(*)::int, max(reviewed_at),
      count(*) FILTER (WHERE reviewed_at>now()-interval '60 minutes')::int FROM second_reviews
      WHERE second_decision IS NOT NULL AND reviewed_at IS NOT NULL`;
    const unknown = await tx`SELECT route_id, model, state, count(*)::int n FROM model_capacity_requests
      WHERE state IN ('dispatched','indeterminate') GROUP BY 1,2,3 ORDER BY 1,2`;
    return { clock, latency, stored, unknown };
  });
  console.log(JSON.stringify(result));
} catch (e) {
  console.error(JSON.stringify({ error: e.code ?? e.name, message: e.message }));
  process.exitCode = 1;
} finally { await sql.end({ timeout: 2 }); }
