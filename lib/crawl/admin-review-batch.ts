import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRepositoryObservations, agentRepositoryScans, type CrawlDocument } from '@/lib/db/schema';
import { normalizeAgentRepositoryKey } from '@/lib/domain/evidence/agents/collect';
import { AGENT_DETECTOR_VERSION, agentObservationSchema, type AgentObservation } from '@/lib/domain/evidence/agents/types';
import type { loadAgentJudgeInput } from './agent-evidence';
import type { CrawlSettings } from './settings-schema';

type AgentJudgeInput = Awaited<ReturnType<typeof loadAgentJudgeInput>>;
type ObservationRow = typeof agentRepositoryObservations.$inferSelect;

/** lib/domain/evidence/agents/repository.ts 의 digest('') — 저장소 전체 범위의 scope_hash */
const ROOT_SCOPE_HASH = createHash('sha256').update(JSON.stringify('')).digest('hex');

/**
 * 심사 화면용 loadAgentJudgeInput() 일괄판.
 *
 * 후보마다 helper 를 부르면 완료 스캔이 있는 후보당 SELECT 4번, 미완료 스캔만 있으면 5번이다 — 근거 강제
 * 모드 50건 화면에서 200~250번. 같은 조건으로 한꺼번에 읽어 스캔 2번 + 관측 0~1번으로 줄인다.
 *
 * 조건은 helper 와 같아야 한다: 저장소 키·전체 범위 해시·현재 검출기 버전으로 거르고, 최신 스캔은
 * started_at 순, 근거 스캔은 완료 스캔 중 completed_at 순(없으면 최신 스캔)이며, 관측은 근거 스캔이 최신
 * 스캔일 때만 싣는다. 화면이 먼저 읽은 스캔은 scope='' 로만 거르고 검출기 버전을 보지 않아 조건이 다르므로
 * 스캔은 다시 읽는다. 관측은 스캔 id 가 같으면 같은 행이라 이미 읽은 것(loaded)을 쓴다.
 * 결과가 helper 와 같은지는 tests/integration/admin-review-batch.test.ts 가 지킨다.
 */
export async function loadAgentJudgeInputs(
  documents: Pick<CrawlDocument, 'repo' | 'pageMeta' | 'fetchedAt'>[],
  settings: CrawlSettings,
  /** 스캔 id 별로 관측을 빠짐없이 읽어 둔 것 */
  loaded: { scanIds: number[]; observations: ObservationRow[] } = { scanIds: [], observations: [] },
): Promise<Map<string, AgentJudgeInput>> {
  const inputs = new Map<string, AgentJudgeInput>();
  if (!documents.length) return inputs;
  const keys = [...new Set(documents.map(document => normalizeAgentRepositoryKey(document.repo)))];
  const current = and(inArray(agentRepositoryScans.repositoryKey, keys), eq(agentRepositoryScans.scopeHash, ROOT_SCOPE_HASH),
    eq(agentRepositoryScans.detectorVersion, AGENT_DETECTOR_VERSION));
  const [latestRows, completeRows] = await Promise.all([
    db.selectDistinctOn([agentRepositoryScans.repositoryKey]).from(agentRepositoryScans).where(current)
      .orderBy(agentRepositoryScans.repositoryKey, desc(agentRepositoryScans.startedAt), desc(agentRepositoryScans.id)),
    db.selectDistinctOn([agentRepositoryScans.repositoryKey]).from(agentRepositoryScans)
      .where(and(current, eq(agentRepositoryScans.state, 'complete')))
      .orderBy(agentRepositoryScans.repositoryKey, desc(agentRepositoryScans.completedAt), desc(agentRepositoryScans.id)),
  ]);
  const latestByKey = new Map(latestRows.map(row => [row.repositoryKey, row]));
  const completeByKey = new Map(completeRows.map(row => [row.repositoryKey, row]));
  const evidenceScanIds = new Set(latestRows.flatMap(row =>
    (completeByKey.get(row.repositoryKey) ?? row).id === row.id ? [row.id] : []));
  const reused = new Set([...evidenceScanIds].filter(id => loaded.scanIds.includes(id)));
  const missing = [...evidenceScanIds].filter(id => !reused.has(id));
  const rows = [
    ...loaded.observations.filter(row => reused.has(row.scanId)),
    ...(missing.length ? await db.select().from(agentRepositoryObservations)
      .where(inArray(agentRepositoryObservations.scanId, missing)) : []),
  ].sort((left, right) => left.id - right.id);
  const observationsByScan = new Map<number, AgentObservation[]>();
  for (const row of rows) {
    const parsed = agentObservationSchema.safeParse(row.facts);
    if (parsed.success) observationsByScan.set(row.scanId, [...(observationsByScan.get(row.scanId) ?? []), parsed.data]);
  }

  // 아래는 loadAgentJudgeInput() 의 판단을 그대로 옮긴 것이다
  const now = Date.now();
  for (const document of documents) {
    const siteAge = now - document.fetchedAt.getTime();
    const rawKeys = siteAge >= 0 && siteAge < 24 * 3600_000 ? document.pageMeta?.repositoryKeys : undefined;
    const pageKeys = Array.isArray(rawKeys) ? [...new Set(rawKeys.filter((key): key is string => typeof key === 'string').map(key => key.replace(/^github:/, '').toLowerCase()))] : [];
    const relationship = pageKeys.length === 1
      ? pageKeys[0] === document.repo.toLowerCase() ? 'same_product' : 'conflict'
      : 'unknown';
    const latest = latestByKey.get(normalizeAgentRepositoryKey(document.repo));
    const fresh = latest?.detectorVersion === settings.agentEvidence.detectorVersion
      && latest.lastErrorCode == null && latest.completedAt
      && now - latest.completedAt.getTime() >= 0 && now - latest.completedAt.getTime() < 24 * 3600_000;
    inputs.set(document.repo, {
      relationship,
      scanState: latest?.state === 'complete' && !fresh ? 'pending' : latest?.state ?? 'pending',
      observations: latest && evidenceScanIds.has(latest.id)
        ? (observationsByScan.get(latest.id) ?? []).filter(observation => observation.scope === '') : [],
      scanId: latest?.id ?? null,
    });
  }
  return inputs;
}
