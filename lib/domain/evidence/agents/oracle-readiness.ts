import { eq, sql } from 'drizzle-orm';
import { crawlSettings, githubCollectorApps } from '@/lib/db/schema';
import { collectorScope, collectorSecret } from '@/lib/crawl/github-secret';
import { mergeWithDefaults } from '@/lib/crawl/settings';
import { unseal } from '@/lib/operations/credential-vault';
import type { OracleConsumerReadiness } from '@/lib/runtime/oracle-consumer-preflight';
import { AGENT_DETECTOR_VERSION } from './types';

/**
 * Oracle 제작 근거 스캔 consumer 의 준비 확인(consumer preflight 의 consumer 항목). 같은 repeatable read TX 에서 자기 프로필의 표만 읽는다.
 *
 * - 수집 자격은 App 전용이어야 한다(GITHUB_COLLECTOR_SOURCES=apps). 개인 토큰 표 권한이 없는 계정이라 다른 자격이면 첫 요청에서 42501 이다.
 * - 수집 비밀키가 있고, 이 서버가 쓸 App 설치(허용 목록이면 그 전부)가 켜져 있으며, 그 개인 키가 이 비밀키로 풀린다(값은 남기지 않는다).
 *   이 계정에는 oracle_principals 에 계정 이름이 든 설치만 보인다(0106 RLS) — 운영자가 허용하지 않은 설치는 app_installation_unavailable 이다.
 * - 제어 행(migration 0105)이 있고 설정의 탐지기 버전이 이 release 와 같다.
 * 모드가 legacy 여도 준비된 것으로 본다 — consumer 는 claim 이 idle 을 돌려주는 동안 쉬고, unit 이 exit 78 을 되풀이하지 않는다.
 * 틀린 설정은 rejected, 바뀔 수 있는 상태(제어 행·탐지기·설치 켜짐)는 unknown 이다. 둘 다 launcher 를 닫는다.
 */
export const agentScanOracleReadiness: OracleConsumerReadiness = async tx => {
  let scope: ReturnType<typeof collectorScope>, secret: string;
  try { scope = collectorScope(); } catch { return { status: 'rejected', reason: 'collector_scope_invalid' }; }
  if (!scope || scope.sources.size !== 1 || !scope.sources.has('apps')) return { status: 'rejected', reason: 'collector_scope_not_apps_only' };
  try { secret = collectorSecret(); } catch { return { status: 'rejected', reason: 'collector_secret_missing' }; }
  const [control] = await tx.execute<{ mode: string }>(sql`SELECT mode FROM agent_scan_control WHERE id = 1`);
  if (!control) return { status: 'unknown', reason: 'agent_scan_control_missing' };
  const [settings] = await tx.select({ values: crawlSettings.values }).from(crawlSettings).where(eq(crawlSettings.id, 1));
  if (mergeWithDefaults(settings?.values).agentEvidence.detectorVersion !== AGENT_DETECTOR_VERSION)
    return { status: 'unknown', reason: 'agent_detector_version_mismatch' };
  const enabled = await tx.select({ installationId: githubCollectorApps.installationId, encryptedPrivateKey: githubCollectorApps.encryptedPrivateKey })
    .from(githubCollectorApps).where(eq(githubCollectorApps.enabled, true));
  const usable = enabled.filter(row => (!scope.onlyInstallations || scope.onlyInstallations.includes(row.installationId))
    && !scope.excludedInstallations?.includes(row.installationId));
  if (!usable.length || scope.onlyInstallations?.some(id => !usable.some(row => row.installationId === id)))
    return { status: 'unknown', reason: 'app_installation_unavailable' };
  try { for (const row of usable) unseal(row.encryptedPrivateKey, secret); }
  catch { return { status: 'rejected', reason: 'collector_secret_mismatch' }; }
  return { status: 'verified', reason: 'agent_scan_ready' };
};
