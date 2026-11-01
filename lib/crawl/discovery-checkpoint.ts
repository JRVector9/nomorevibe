import { sql } from "drizzle-orm";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { logger } from "@/lib/observability/logger";
import { DISCOVERY_MAX_SUBJECTS, DISCOVERY_SOURCES, type DiscoveryCheckpointInput } from "./discovery-checkpoint-contract";

const HASH = /^[a-f0-9]{64}$/;
/** Savepoints keep missing schema/grants/monitoring failures from undoing productive work.
 * A receipt that succeeds is committed atomically with the caller's actual work. */
export async function checkpointDiscovery(tx: ProductTransaction, receipts: readonly DiscoveryCheckpointInput[]): Promise<void> {
  try {
    await tx.transaction(async sp => {
      const deadlineAt = Date.now() + 1_000;
      const [timeouts] = await sp.execute<{ statement: string; lock: string }>(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`);
      await sp.execute(sql`SELECT set_config(name,least(CASE WHEN setting::bigint=0 THEN 500 ELSE setting::bigint END,
        CASE WHEN name='lock_timeout' THEN 100 ELSE 500 END)::text||'ms',true) FROM pg_settings WHERE name IN ('statement_timeout','lock_timeout')`);
      if (receipts.length > DISCOVERY_MAX_SUBJECTS) throw new Error("discovery_checkpoint_bound");
      // Oracle has no DELETE grant. Home writers prune retired subjects after seven days.
      if (receipts.some(r => r.source === "github-full" || r.source === "show-hn" || r.source === "korean-apply"))
        await sp.execute(sql`DELETE FROM discovery_checkpoints WHERE (source,subject) IN
          (SELECT source,subject FROM discovery_checkpoints WHERE recorded_at<clock_timestamp()-interval '7 days'
            ORDER BY recorded_at LIMIT 20 FOR UPDATE SKIP LOCKED)`);
      for (const r of [...receipts].sort((a, b) => a.source.localeCompare(b.source) || a.subject.localeCompare(b.subject))) {
        if (Date.now() >= deadlineAt) throw new Error("discovery_checkpoint_deadline");
        if (!(DISCOVERY_SOURCES as readonly string[]).includes(r.source) || ![r.subject, r.generation, r.semantic].every(v => HASH.test(v))
          || r.reference !== undefined && (r.reference.length > 200 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.reference))) throw new Error("invalid_discovery_checkpoint");
        const written = await sp.execute(sql`WITH available AS (
            SELECT slot FROM discovery_checkpoints WHERE source=${r.source} AND subject=${r.subject}
            UNION ALL SELECT candidate::smallint FROM generate_series(0,${DISCOVERY_MAX_SUBJECTS - 1}) candidate
              WHERE NOT EXISTS(SELECT 1 FROM discovery_checkpoints WHERE source=${r.source} AND slot=candidate) LIMIT 1)
          INSERT INTO discovery_checkpoints(source,subject,slot,generation,semantic,reference,intent,resume_at,revision,first_seen_at,progress_at,acknowledged_at,recorded_at)
          SELECT ${r.source},${r.subject},available.slot,${r.generation},${r.semantic},${r.reference ?? null},${r.intent},${r.resumeAt ?? null}::timestamp,
            ${r.progressed ? 1 : 0},clock_timestamp(),CASE WHEN ${r.progressed === true} THEN clock_timestamp() END,
            CASE WHEN ${r.acknowledged === true} THEN clock_timestamp() END,clock_timestamp() FROM available WHERE true
          ON CONFLICT(source,subject) DO UPDATE SET generation=excluded.generation,semantic=excluded.semantic,reference=excluded.reference,
            intent=excluded.intent,resume_at=excluded.resume_at,recorded_at=excluded.recorded_at,
            first_seen_at=CASE WHEN discovery_checkpoints.generation<>excluded.generation
              OR discovery_checkpoints.semantic<>excluded.semantic AND NOT ${r.progressed === true} THEN excluded.first_seen_at ELSE discovery_checkpoints.first_seen_at END,
            revision=CASE WHEN discovery_checkpoints.generation<>excluded.generation THEN excluded.revision
              WHEN ${r.progressed === true} AND discovery_checkpoints.semantic<>excluded.semantic THEN least(discovery_checkpoints.revision+1,9007199254740991)
              ELSE discovery_checkpoints.revision END,
            progress_at=CASE WHEN discovery_checkpoints.generation<>excluded.generation
              OR discovery_checkpoints.semantic<>excluded.semantic AND NOT ${r.progressed === true} THEN excluded.progress_at
              WHEN ${r.progressed === true} AND discovery_checkpoints.semantic<>excluded.semantic THEN excluded.progress_at ELSE discovery_checkpoints.progress_at END,
            acknowledged_at=CASE WHEN discovery_checkpoints.generation<>excluded.generation
              OR discovery_checkpoints.semantic<>excluded.semantic AND NOT ${r.progressed === true} THEN excluded.acknowledged_at
              ELSE coalesce(excluded.acknowledged_at,discovery_checkpoints.acknowledged_at) END RETURNING source`);
        // A concurrent new subject may contend for a slot; losing the receipt never loses source work.
        if (!written.length) throw new Error("discovery_checkpoint_full");
      }
      await sp.execute(sql`SELECT set_config('statement_timeout',${timeouts.statement},true),set_config('lock_timeout',${timeouts.lock},true)`);
    });
  } catch { logger.warn("crawl.discovery_checkpoint_unavailable"); }
}
