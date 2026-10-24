import { sql, type SQL } from "drizzle-orm";

/** products 별칭의 현재 세대. shadow의 유일한 예외는 같은 TX에 남긴 legacy 내림 감사다. */
export function uptimeAssistSubjectCurrent(source: SQL, shadowEnabled: SQL): SQL<boolean> {
  return sql<boolean>`(products.id::text=${source}->'product'->>'id'
    and products.slug=${source}->'product'->>'slug' and products.url=${source}->'product'->>'url'
    and products.access_mode='website' and products.updated_at::text=${source}->'product'->>'updatedAt'
    and ((not (${source} ? 'shadowBan') and products.status in ('seeded','verified'))
      or (${shadowEnabled} and products.status='banned' and exists (
        select 1 from operations_audit a where a.id=case
          when (${source}->'shadowBan'->>'auditId') ~ '^[1-9][0-9]{0,15}$'
          then (${source}->'shadowBan'->>'auditId')::bigint else null end
          and a.actor='system:uptime' and a.action='product-auto-ban-uptime' and a.ok and a.target=products.slug
          and a.detail->>'policy'='uptime_consecutive_failures' and a.detail->>'status'='banned'
          and a.detail->>'productId'=products.id::text and a.detail->>'slug'=products.slug and a.detail->>'url'=products.url
          and a.detail->>'bannedProductUpdatedAt'=products.updated_at::text
          and a.detail->>'observedProductUpdatedAt'=${source}->'shadowBan'->>'observedProductUpdatedAt'
          and a.detail->>'checkedAtRevision'=${source}->'health'->>'checkedAt'
          and a.detail->>'downSinceRevision'=${source}->'health'->>'downSince'
          and a.detail->>'consecutiveFailures'=${source}->'health'->>'failures'
          and a.detail->>'lastStatus'=${source}->'health'->>'status'
          and not exists (select 1 from product_evidence_audit unban where unban.slug=products.slug
            and unban.action='admin.product.unban' and unban.created_at>=a.created_at)
      ))))`;
}
