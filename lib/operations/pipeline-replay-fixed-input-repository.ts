import { sql, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { agentRepositoryObservations, agentRepositoryScans, crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings,
  type AgentRepositoryScan, type CrawlCandidate, type CrawlDocument } from "@/lib/db/schema";
import { createReviewInput, isReviewCandidate, reviewPolicyHash, type ReviewSource } from "@/lib/crawl/agent-review-contract";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { judgeCrawlDocuments } from "@/lib/crawl/jobs/judge";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { runJob } from "@/lib/jobs/runner";
import { FIXED_INPUT_MAX_INPUTS, FIXED_INPUT_MIN_HEADROOM_MS, fixedInputSampleKey, fixedInputSetHash, parseFixedInputArtifact,
  type FixedInput, type FixedInputArtifact } from "./pipeline-replay-fixed-input";

type Database = PostgresJsDatabase<typeof schema>;
type Row = Record<string, unknown>;
const POPULATION_LIMIT = 200_000, CHUNK = 100, MAX_INPUT_BYTES = 2 * 1024 * 1024;
function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
const canonicalDate = (value: string) => Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const ms = (text: string | null | undefined) => text ? Date.parse(text) : null;
const ageUs = (value: unknown) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

/**
 * 운영 DB 읽기 전용 export. 지정 구간에 실제로 1차 모델 심사를 마친 후보 중 seed 순서로 N건을 고른다.
 * 자격은 원래 심사 입력을 지금 남은 행으로 똑같이 다시 만들 수 있는 것뿐이다: 원본·스캔이 그 뒤로 바뀌지 않았고,
 * README 표본이 있고, 이 코드로 다시 만든 의미 입력 해시가 운영 attempt의 input_hash와 같다.
 * 담는 것은 공개 GitHub 메타·공개 페이지 원문·스캔 관찰과 크롤 설정뿐이다. 관리자·사용자·세션·actor·사유·updated_by는 읽지 않는다.
 */
export async function exportFixedInputs(database: Database, options: { from: string; to: string; seed: string; count: number;
  revision: string }): Promise<FixedInputArtifact> {
  const { from, to, seed, count } = options;
  ensure(canonicalDate(from) && canonicalDate(to) && Date.parse(from) < Date.parse(to)
    && Number.isSafeInteger(count) && count >= 1 && count <= FIXED_INPUT_MAX_INPUTS, "fixed_input_export_window_invalid");
  return database.transaction(async tx => {
    const query = async (statement: ReturnType<typeof sql>) => [...await tx.execute(statement)] as Row[];
    await tx.execute(sql`set transaction isolation level repeatable read, read only`);
    await tx.execute(sql`set local time zone 'UTC'`);
    await tx.execute(sql`set local statement_timeout = '120s'`);
    const [clock] = await query(sql`select to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`);
    const [stored] = await query(sql`select values from crawl_settings where id = 1`);
    const settings = mergeWithDefaults(stored?.values);
    ensure(settings.firstReview, "fixed_input_first_reviewer_unpinned");
    const first = settings.firstReview, inputPolicyHash = reviewPolicyHash(settings);
    const start = sql`(${from}::timestamptz at time zone 'utc')`, end = sql`(${to}::timestamptz at time zone 'utc')`;
    const model = sql`a.kind = 'automatic' and a.state = 'succeeded' and a.reused_from_attempt_id is null
      and a.provider is distinct from 'rules' and a.started_at >= ${start} and a.started_at < ${end}`;
    // 후보마다 구간 안 첫 성공 모델 심사 하나. 그때의 판단은 참고값이다(정답 라벨이 아니다).
    const population = await query(sql`select a.id, a.candidate_id, a.input_hash, a.provider, a.model,
        a.outcome->>'decision' as decision from crawl_review_attempts a where ${model}
        and not exists (select 1 from crawl_review_attempts b where b.candidate_id = a.candidate_id and b.id < a.id
          and b.kind = 'automatic' and b.state = 'succeeded' and b.reused_from_attempt_id is null
          and b.provider is distinct from 'rules' and b.started_at >= ${start} and b.started_at < ${end})
      order by a.id limit ${POPULATION_LIMIT + 1}`);
    ensure(population.length <= POPULATION_LIMIT, "fixed_input_population_limit");
    const ordered = population.map(row => ({ row, key: fixedInputSampleKey(seed, Number(row.candidate_id)) }))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(item => item.row);
    const exclusions = { modelChanged: 0, documentChanged: 0, scanChanged: 0, readmeMissing: 0, headroom: 0, inputDrift: 0, oversize: 0 };
    const inputs: FixedInput[] = [];
    let examined = 0;
    for (let offset = 0; offset < ordered.length && inputs.length < count; offset += CHUNK) {
      const chunk = ordered.slice(offset, offset + CHUNK), ids = chunk.map(row => Number(row.id));
      const details = new Map((await query(sql`select a.id as attempt_id, c.id as candidate_id, c.repo, a.source,
          to_char(a.started_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as anchor_at,
          d.id as document_id, d.repo_meta, d.product_url, d.page_status, d.page_meta,
          to_char(d.fetched_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as fetched_at,
          round(extract(epoch from (a.started_at - d.fetched_at)) * 1000000)::bigint::text as fetched_age_us,
          s.id as scan_id, s.github_repository_id::text as github_repository_id, s.commit_sha, s.detector_version, s.scope, s.scope_hash,
          s.state as scan_state, s.cursor, s.request_count, s.file_count, s.coverage, s.last_error_code,
          to_char(s.started_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as scan_started_at,
          to_char(s.completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as scan_completed_at,
          round(extract(epoch from (a.started_at - s.started_at)) * 1000000)::bigint::text as scan_started_age_us,
          round(extract(epoch from (a.started_at - s.completed_at)) * 1000000)::bigint::text as scan_completed_age_us
        from crawl_review_attempts a join crawl_candidates c on c.id = a.candidate_id
        left join crawl_documents d on d.repo = c.repo
        left join agent_repository_scans s on jsonb_typeof(a.source->'scanId') = 'number' and s.id = (a.source->>'scanId')::int
        where a.id in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`))
        .map(row => [Number(row.attempt_id), row]));
      const scanIds = [...details.values()].map(row => row.scan_id).filter(id => id !== null && id !== undefined).map(Number);
      const observations = scanIds.length ? await query(sql`select o.id, o.scan_id, o.observation_key, o.facts,
          round(extract(epoch from (a.started_at - o.observed_at)) * 1000000)::bigint::text as observed_age_us
        from agent_repository_observations o join crawl_review_attempts a
          on jsonb_typeof(a.source->'scanId') = 'number' and (a.source->>'scanId')::int = o.scan_id
        where a.id in (${sql.join(ids.map(id => sql`${id}`), sql`, `)}) order by o.scan_id, o.id`) : [];
      for (const row of chunk) {
        if (inputs.length >= count) break;
        examined++;
        const detail = details.get(Number(row.id));
        if (!detail) { exclusions.documentChanged++; continue; }
        if (row.provider !== first.provider || row.model !== first.model) { exclusions.modelChanged++; continue; }
        const source = detail.source as ReviewSource, anchorAt = String(detail.anchor_at), anchor = new Date(anchorAt);
        const fetchedAge = ageUs(detail.fetched_age_us);
        if (detail.document_id === null || detail.document_id === undefined || Number(detail.document_id) !== source.documentId
          || ms(detail.fetched_at as string) !== ms(source.documentFetchedAt) || fetchedAge === null) { exclusions.documentChanged++; continue; }
        const pageMeta = (detail.page_meta ?? null) as Record<string, unknown> | null;
        if (typeof pageMeta?.readmeSample !== "string" || pageMeta.readmeSampleVersion !== README_SAMPLE_VERSION) { exclusions.readmeMissing++; continue; }
        const scanned = source.scanId !== null && source.scanId !== undefined;
        const startedAge = ageUs(detail.scan_started_age_us), completedAge = detail.scan_completed_at ? ageUs(detail.scan_completed_age_us) : null;
        if (scanned !== (detail.scan_id !== null && detail.scan_id !== undefined) || scanned && (Number(detail.scan_id) !== source.scanId
          || ms(detail.scan_completed_at as string | null) !== ms(source.scanCompletedAt) || startedAge === null
          || detail.scan_completed_at && completedAge === null || detail.scope !== "")) { exclusions.scanChanged++; continue; }
        const repo = String(detail.repo), productUrl = (detail.product_url ?? null) as string | null;
        const document: CrawlDocument = { id: Number(detail.document_id), repo, repoMeta: detail.repo_meta as Record<string, unknown>,
          productUrl, pageStatus: (detail.page_status ?? null) as number | null, pageMeta, fetchedAt: new Date(ms(detail.fetched_at as string)!) };
        const candidate: CrawlCandidate = { id: Number(detail.candidate_id), repo, productUrl, state: "approved", reason: "passed",
          decidedBy: "auto", signals: {}, publishedSlug: null, judgedAt: source.candidateJudgedAt ? new Date(source.candidateJudgedAt) : null,
          decidedAt: null, updatedAt: anchor };
        const scan: AgentRepositoryScan | null = scanned ? { id: Number(detail.scan_id), githubRepositoryId: BigInt(String(detail.github_repository_id)),
          repositoryKey: repo.toLowerCase(), commitSha: String(detail.commit_sha), detectorVersion: String(detail.detector_version),
          scope: "", scopeHash: String(detail.scope_hash), state: detail.scan_state as AgentRepositoryScan["state"],
          cursor: (detail.cursor ?? null) as AgentRepositoryScan["cursor"], requestCount: Number(detail.request_count),
          fileCount: Number(detail.file_count), coverage: detail.coverage as AgentRepositoryScan["coverage"],
          startedAt: new Date(ms(detail.scan_started_at as string)!), completedAt: detail.scan_completed_at ? new Date(ms(detail.scan_completed_at as string)!) : null,
          lastErrorCode: (detail.last_error_code ?? null) as string | null, nextAttemptAt: anchor } : null;
        const own = observations.filter(item => scanned && Number(item.scan_id) === source.scanId);
        if (own.some(item => ageUs(item.observed_age_us) === null)) { exclusions.scanChanged++; continue; }
        // 원래 심사 시각(anchor)을 의미 시각으로 넣어 이 코드로 입력을 다시 만든다. 운영 해시와 다르면 같은 입력이 아니다.
        const input = createReviewInput(candidate, document, settings, { scan,
          observations: own.map(item => ({ id: `observation:${item.id}`, observation: item.facts as never })) }, anchor);
        if (input.validUntil.getTime() - anchor.getTime() < FIXED_INPUT_MIN_HEADROOM_MS) { exclusions.headroom++; continue; }
        if (input.inputHash !== row.input_hash) { exclusions.inputDrift++; continue; }
        const entry: FixedInput = { ordinal: inputs.length + 1, repo,
          production: { candidateId: Number(detail.candidate_id), attemptId: Number(row.id), inputHash: String(row.input_hash),
            decision: row.decision as FixedInput["production"]["decision"], provider: String(row.provider), model: String(row.model) },
          anchorAt, inputHash: input.inputHash,
          document: { repoMeta: document.repoMeta, productUrl, pageStatus: document.pageStatus, pageMeta, fetchedAgeUs: fetchedAge },
          scan: scan ? { githubRepositoryId: String(detail.github_repository_id), commitSha: scan.commitSha, detectorVersion: scan.detectorVersion,
            scope: "", scopeHash: scan.scopeHash, state: scan.state, cursor: scan.cursor ?? null, requestCount: scan.requestCount,
            fileCount: scan.fileCount, coverage: scan.coverage as Record<string, unknown>, startedAgeUs: startedAge!,
            completedAgeUs: completedAge, lastErrorCode: scan.lastErrorCode } : null,
          observations: own.map(item => ({ observationKey: String(item.observation_key), facts: item.facts as Record<string, unknown>,
            observedAgeUs: ageUs(item.observed_age_us)! })) };
        if (Buffer.byteLength(JSON.stringify(entry), "utf8") > MAX_INPUT_BYTES) { exclusions.oversize++; continue; }
        inputs.push(entry);
      }
    }
    const [xid] = await query(sql`select txid_current_if_assigned() is not null as assigned`);
    ensure(xid.assigned === false, "fixed_input_export_write_detected");
    // 자격 통과가 없으면 진단용 개수만 실어 보낸다(원문·식별자 없음).
    if (!inputs.length) throw Object.assign(new Error("replay_inputs_empty"), { exportSummary: { population: population.length, examined, exclusions } });
    return parseFixedInputArtifact({ version: 1, scope: "fixed_input_replay",
      export: { revision: options.revision, exportedAt: String(clock.now), from, to, seed, requested: count, population: population.length,
        examined, selected: inputs.length, exclusions, firstReviewer: { provider: first.provider, model: first.model }, inputPolicyHash },
      settings: JSON.parse(JSON.stringify(settings)) as Record<string, unknown>, inputs });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export type FixedInputLoad = { anchorAt: string; loaded: number; items: { ordinal: number; inputHash: string }[];
  excluded: { notReviewable: number; inputDrift: number }; ordinalByRepo: Map<string, number>; inputSetHash: string };

const DOMAIN_TABLES = ["crawl_candidates", "crawl_documents", "crawl_frontier", "crawl_review_attempts", "second_reviews",
  "agent_repository_scans", "products", "pipeline_item_leases"] as const;
export async function dbClockIso(): Promise<string> {
  const [row] = await db.execute<{ now: string }>(sql`select to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`);
  return row.now;
}

/**
 * 격리 DB(호출자가 loopback 관문을 이미 통과시킨 global db)에 artifact를 적재한다. 비어 있지 않으면 거부한다.
 * 근거 시각은 anchor(DB 시계) − 원래 나이로 다시 세우고, 판정은 운영 판정 잡을 입력 순서대로 하나씩 돌려 만든다
 * (후보 순서·updated_at이 두 실행에서 같다). 의미 입력 해시가 artifact와 다른 후보는 실행 전에 지운다.
 */
export async function loadFixedInputs(input: { artifact: FixedInputArtifact; settings: CrawlSettings; mode: "legacy" | "items";
  capacityPolicy?: ModelCapacityPolicy }): Promise<FixedInputLoad> {
  const artifact = parseFixedInputArtifact(input.artifact), { settings, mode } = input;
  ensure(mode === "legacy" || input.capacityPolicy, "invalid_replay_mode");
  const [counts] = await db.execute<Record<string, number>>(sql.raw(`select ${DOMAIN_TABLES.map(name =>
    `(select count(*)::int from public.${name}) as ${name}`).join(", ")}`));
  ensure(DOMAIN_TABLES.every(name => Number(counts[name]) === 0), "replay_database_not_empty");
  // 모델 슬롯 장부(0078)는 지울 수 없고 AI1 dispatch의 attemptId가 전역 유일이다. 재사용한 DB에서 attempt 번호가 되감겼으면
  // 실행 중 consumer가 유일성 위반으로 멈추므로 적재 전에 거부한다(실행마다 새 컨테이너를 쓰면 생기지 않는다).
  const [sequence] = await db.execute<{ next: string; used: string }>(sql`select
    (select case when is_called then last_value + 1 else last_value end from crawl_review_attempts_id_seq)::text as next,
    (select coalesce(max((dispatch_binding->>'attemptId')::bigint), 0) from model_capacity_requests where dispatch_binding ? 'attemptId')::text as used`);
  ensure(BigInt(sequence.next) > BigInt(sequence.used), "replay_database_not_empty");
  const anchorAt = await dbClockIso();
  await db.transaction(async tx => {
    await tx.insert(crawlSettings).values({ id: 1, values: settings as unknown as Record<string, unknown>, updatedBy: "pipeline-replay",
      updatedAt: sql`(now() at time zone 'utc')` }).onConflictDoUpdate({ target: crawlSettings.id,
      set: { values: settings as unknown as Record<string, unknown>, updatedBy: "pipeline-replay", updatedAt: sql`(now() at time zone 'utc')` } });
    if (mode === "legacy") {
      await tx.execute(sql`update pipeline_stage_modes set mode = 'legacy', draining_from = null, updated_at = clock_timestamp()
        where mode <> 'legacy' or draining_from is not null`);
      await tx.execute(sql`update model_capacity_control set mode = 'disabled', updated_at = clock_timestamp() where id = 1 and mode <> 'disabled'`);
    } else {
      const policy = input.capacityPolicy!;
      await tx.execute(sql`update pipeline_stage_modes set mode = case when stage = 'fetch' then 'legacy' else 'items' end, draining_from = null,
        writer_contract_version = case when stage = 'fetch' then writer_contract_version else greatest(writer_contract_version, 1) end,
        updated_at = clock_timestamp()`);
      await tx.execute(sql`update model_capacity_control set mode = 'open', policy = ${JSON.stringify(policy)}::jsonb,
        policy_hash = ${modelCapacityPolicyHash(policy)}, updated_at = clock_timestamp() where id = 1`);
    }
  });
  const at = (age: number) => sql`((${anchorAt}::timestamptz at time zone 'utc') - (${String(age)} || ' microseconds')::interval)`;
  const ordinalByRepo = new Map<string, number>(), excluded = { notReviewable: 0, inputDrift: 0 };
  const items: { ordinal: number; inputHash: string }[] = [];
  const drop = (repo: string) => db.transaction(async tx => {
    await tx.delete(crawlCandidates).where(eq(crawlCandidates.repo, repo));
    await tx.delete(crawlDocuments).where(eq(crawlDocuments.repo, repo));
    await tx.delete(agentRepositoryScans).where(eq(agentRepositoryScans.repositoryKey, repo.toLowerCase()));
    await tx.delete(crawlFrontier).where(eq(crawlFrontier.repo, repo));
  });
  for (const row of artifact.inputs) {
    await db.transaction(async tx => {
      await tx.insert(crawlFrontier).values({ repo: row.repo, signal: "pipeline-replay", state: "done" });
      await tx.insert(crawlDocuments).values({ repo: row.repo, repoMeta: row.document.repoMeta, productUrl: row.document.productUrl,
        pageStatus: row.document.pageStatus, pageMeta: row.document.pageMeta, fetchedAt: at(row.document.fetchedAgeUs) as never });
      if (row.scan) {
        const [scan] = await tx.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(row.scan.githubRepositoryId),
          repositoryKey: row.repo.toLowerCase(), commitSha: row.scan.commitSha, detectorVersion: row.scan.detectorVersion, scope: "",
          scopeHash: row.scan.scopeHash, state: row.scan.state, cursor: row.scan.cursor as never, requestCount: row.scan.requestCount,
          fileCount: row.scan.fileCount, coverage: row.scan.coverage as never, startedAt: at(row.scan.startedAgeUs) as never,
          completedAt: (row.scan.completedAgeUs === null ? null : at(row.scan.completedAgeUs)) as never,
          lastErrorCode: row.scan.lastErrorCode, nextAttemptAt: at(0) as never }).returning({ id: agentRepositoryScans.id });
        if (row.observations.length) await tx.insert(agentRepositoryObservations).values(row.observations.map(item => ({ scanId: scan.id,
          observationKey: item.observationKey, facts: item.facts as never, observedAt: at(item.observedAgeUs) as never })));
      }
    });
    // 운영 판정 잡 그대로. 대기열에는 방금 넣은 원본 하나뿐이라 후보 순서가 artifact 순서와 같다.
    await runJob("crawl-judge", judgeCrawlDocuments, { budgetMs: 25_000 });
    const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, row.repo));
    const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, row.repo));
    if (!candidate || !document || !isReviewCandidate(candidate) || candidate.signals?.starAutoApproval) {
      excluded.notReviewable++; await drop(row.repo); continue;
    }
    const current = await loadReviewInput(candidate, document, settings);
    if (current.inputHash !== row.inputHash) { excluded.inputDrift++; await drop(row.repo); continue; }
    ordinalByRepo.set(row.repo.toLowerCase(), row.ordinal);
    items.push({ ordinal: row.ordinal, inputHash: row.inputHash });
  }
  return { anchorAt, loaded: artifact.inputs.length, items, excluded, ordinalByRepo, inputSetHash: fixedInputSetHash(items) };
}

/** 수집한 live artifact의 DB 후보 번호를 artifact 순번으로 바꾼다. 두 실행의 라벨·비교 열쇠가 같아진다. */
export async function fixedInputOrdinals(ordinalByRepo: ReadonlyMap<string, number>): Promise<Map<number, number>> {
  const rows = await db.select({ id: crawlCandidates.id, repo: crawlCandidates.repo }).from(crawlCandidates);
  const mapped = new Map<number, number>();
  for (const row of rows) {
    const ordinal = ordinalByRepo.get(row.repo.toLowerCase());
    ensure(ordinal, "replay_candidate_unmapped");
    mapped.set(row.id, ordinal);
  }
  return mapped;
}

/** 공개 상태 쓰기 증거: 격리 DB 제품 행과 발행 잡 실행 수. 둘 다 0이어야 한다. */
export async function fixedInputWrites(): Promise<{ products: number; publishRuns: number }> {
  const [row] = await db.execute<{ products: number; publish_runs: number }>(sql`select (select count(*)::int from products) as products,
    coalesce((select runs from jobs where name = 'crawl-publish'), 0)::int as publish_runs`);
  return { products: Number(row.products), publishRuns: Number(row.publish_runs) };
}
