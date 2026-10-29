import { assertHostBudgetEntrySupported } from '@/lib/operations/host-budget';
import { eq, sql } from 'drizzle-orm';
import { githubCollectorApps } from '@/lib/db/schema';
import { collectorScope, collectorSecret } from '@/lib/crawl/github-secret';
import { unseal } from '@/lib/operations/credential-vault';
import type { OracleConsumerReadiness } from '@/lib/runtime/oracle-consumer-preflight';

export const koreanDiscoveryOracleReadiness: OracleConsumerReadiness = async tx => {
  try { assertHostBudgetEntrySupported(process.env); }
  catch { return { status: 'rejected', reason: 'korean_host_budget_enforcement_unsupported' }; }
  if (process.env.GITHUB_KO_DISCOVERY_VERSION !== '1') return { status: 'unknown', reason: 'korean_discovery_disabled' };
  if (process.env.HTTP_ORIGIN_PERMITS !== undefined && process.env.HTTP_ORIGIN_PERMITS !== '0')
    return { status: 'rejected', reason: 'korean_http_permits_unsupported' };
  let scope: ReturnType<typeof collectorScope>, secret: string;
  try { scope = collectorScope(); secret = collectorSecret(); }
  catch { return { status: 'rejected', reason: 'korean_collector_configuration_invalid' }; }
  if (!scope || scope.sources.size !== 1 || !scope.sources.has('apps')) return { status: 'rejected', reason: 'collector_scope_not_apps_only' };
  const [control] = await tx.execute<{ enabled: boolean; start_at: Date | null }>(sql`SELECT enabled,start_at FROM github_ko_discovery_control WHERE id=1`);
  if (!control) return { status: 'unknown', reason: 'korean_control_missing' };
  if (control.enabled && !control.start_at) return { status: 'rejected', reason: 'korean_history_start_missing' };
  const enabled = await tx.select({ installationId: githubCollectorApps.installationId, encryptedPrivateKey: githubCollectorApps.encryptedPrivateKey })
    .from(githubCollectorApps).where(eq(githubCollectorApps.enabled, true));
  const usable = enabled.filter(row => (!scope.onlyInstallations || scope.onlyInstallations.includes(row.installationId)) && !scope.excludedInstallations?.includes(row.installationId));
  if (!usable.length || scope.onlyInstallations?.some(id => !usable.some(row=>row.installationId===id)))
    return { status: 'unknown', reason: 'app_installation_unavailable' };
  try { for (const row of usable) unseal(row.encryptedPrivateKey, secret); }
  catch { return { status: 'rejected', reason: 'collector_secret_mismatch' }; }
  return { status: 'verified', reason: control.enabled ? 'korean_discovery_ready' : 'korean_discovery_standby_ready' };
};
