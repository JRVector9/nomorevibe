import { sql, type SQLWrapper } from "drizzle-orm";

/** 같은 현재 health/제품 세대의 검증된 증거만 자동 부정 판단에 쓴다. disabled는 기존 의미다. */
export function uptimeNegativeAllowed(fields: {
  id: SQLWrapper; url: SQLWrapper; updatedAt: SQLWrapper; checkedAt: SQLWrapper;
  failures: SQLWrapper; status: SQLWrapper;
}) {
  return sql<boolean>`(not exists (select 1 from uptime_control uc where uc.id=1 and uc.gate_enabled)
    or exists (select 1 from uptime_gates ug
      join uptime_control uc on uc.id=1 and uc.gate_enabled and uc.observations_enabled
      join uptime_observations uo on uo.observation_id=ug.applied_observation_id
      where ug.product_id=${fields.id} and ug.url=${fields.url}
        and ug.product_updated_at=${fields.updatedAt}
        and ug.state='admitted' and ug.policy_version='regional-v1' and ug.revision=uc.revision and uo.revision=uc.revision
        and uo.disposition='applied' and uo.product_id=ug.product_id and uo.url=ug.url
        and ug.health_checked_at=${fields.checkedAt} and ug.failures=${fields.failures} and ug.status=${fields.status}
        and ug.health_checked_at between clock_timestamp() - interval '6 hours' and clock_timestamp()))`;
}
