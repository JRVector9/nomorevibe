import { parseCliEngineRevision, type CliEngineSource } from "@/lib/llm/cli-engine-config";
import { eq } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { productAuditCampaigns } from "@/lib/db/schema";
import { legacyFirstReviewers } from "@/lib/crawl/first-reviewers";
import { underlyingReviewModel } from "@/lib/crawl/review-model-identity";
import { resolveAi1GatewayServingContract } from "@/lib/crawl/agent-review-serving-contract";
import { resolveAi2GatewayServingContract } from "@/lib/crawl/second-review-serving-contract";
import { koreanTranslationQwenEnabled } from "@/lib/crawl/korean-translation-config";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { QWEN_AUDIT_PROVIDER } from "@/lib/crawl/product-audit-reviewer";
import { qwenDirectConfig } from "@/lib/crawl/qwen-direct-review";
import { assistBackendDrains } from "@/lib/domain/llm-assist/config";
import { EMBEDDING_MODEL } from "@/lib/domain/products/embedding";
import { tableStageSelections, withAdminModelStage, withAdminStagePools } from "@/lib/llm/admin-model-pools";
import { ADMIN_MODEL_STAGES, type AdminModelStage } from "@/lib/llm/admin-model-stages";
import { AI_TASKS, aiCliToolOfProvider, type AiTaskDef, type AiTextTaskId } from "@/lib/llm/ai-tasks";
import { ensureAiTaskModels } from "@/lib/llm/ai-task-models-snapshot";
import { resolveTextTaskRanks, textRankUnusableText } from "@/lib/llm/ai-task-resolver";
import type { ModelCapacityPolicy } from "@/lib/llm/capacity";
import type { AssignmentStage } from "@/lib/llm/capacity-helpers";
import { configuredModel, modelBaseUrl, modelForPurpose, modelRequestName, MODEL_PURPOSE_ENV, readModelRegistry } from "@/lib/llm/model-registry";
import { ensureServingContracts, servingContractSnapshot, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import { ensureStageAssignments, stageAssignmentRows } from "@/lib/llm/stage-assignment-snapshot";
import { ADMIN_STAGE_ASSIGNMENTS } from "@/lib/llm/stage-assignments";
import { screenModelConfig } from "@/lib/screen-review/vision-review";
import { aiConnectionBaseUrl, type AiCurrentSlot, type AiCurrentUse } from "./admin-ai-tasks";
import { assignmentFlagState } from "./admin-assignment-source";
import { knownClassificationProvider } from "./classification-models";
import type { AgentStatus } from "./contracts";
import type { ModelEnv } from "./pipeline-control";

/**
 * 「지금 실제로 쓰는 모델」 — 작업 × 칸마다 오늘 실행 쪽이 고르는 모델과 그 서버(2026-11-02, PR A). 새 표(ai_task_models)는 읽지 않는다.
 * 고르기는 오늘의 코드 그대로를 부른다: 1차·2차·Grok 로그인 유지는 PR C1 부터 실행 쪽이 순위만 읽으므로 가져오기 출처인 옛 설정(1차 firstReview·
 * firstReviewAdditional, 2차 voters·fallbacks — 같은 대체 모델은 첫 칸에만)·text 일곱 경로는 PR B 부터 실행 쪽이 이 표를 읽으므로
 * 저장한 순위 그대로(resolveTextTaskRanks — 쓸 수 없는 순위는 그 까닭)·
 * 직접 모델 단계의 withAdminStagePools/withAdminModelStage 안의 configuredModel·modelBaseUrl(등록부·env·단계 풀)·화면 판별 screenModelConfig·
 * 보강 assistBackendDrains·분류 connect 에이전트 설정·감사 캠페인 행·임베딩/재정렬 EMBEDDING_URL·RERANK_URL.
 * 서버 주소는 지어내지 않는다: text·1차·2차는 켜진 연결 계약의 endpoint, 직접 모델 단계는 그 단계가 실제로 부르는 등록부·env 주소다. 모르면 null(가져오기가 건너뛴다).
 * 이 값은 웹 프로세스의 env 기준이다 — 워커의 env 가 다르면 다를 수 있다(화면이 그렇게 적는다).
 */
export type AiCurrentSources = Readonly<{
  settings: CrawlSettings;
  modelEnv: ModelEnv;
  policy: ModelCapacityPolicy | null;
  agent: AgentStatus | null;
  auditCampaign: Readonly<{ provider: string; model: string }> | null;
  tableOn: boolean;
  /** 배정 표 스위치를 읽지 못했다 — 표가 켜졌는지 모르므로 풀을 오늘 값이라고 하지 않는다. */
  tableUnknown?: boolean;
  /** 설정을 읽지 못해 기본값으로 대신했다 — 단계 풀을 오늘 값이라고 하지 않는다. */
  settingsUnknown?: boolean;
  /** 검색 API 설정(안전한 값만: 키·원래 오류는 넘기지 않는다). 없으면 옛 env 폴백(순수 시험). */
  searchModels?: Readonly<Record<string, { source: string; model: string | null; baseUrl: string | null; error: string | null }>>;
  env: Readonly<Record<string, string | undefined>>;
}>;

const field = (contract: unknown, name: string): string | null => {
  const value = contract && typeof contract === "object" ? (contract as Record<string, unknown>)[name] : undefined;
  return typeof value === "string" && value ? value : null;
};
const baseOf = (endpoint: string | null | undefined) => endpoint ? aiConnectionBaseUrl(endpoint) : null;
const errorText = (error: unknown) => error instanceof Error ? error.message.slice(0, 120) : "read_failed";

export function buildAiCurrentSlots(sources: AiCurrentSources): AiCurrentSlot[] {
  const contracts = servingContractSnapshot().rows;
  const routes = sources.policy?.routes ?? [];
  const groupOf = (routeId: string | null, provider: string, model: string) =>
    routeId ? routes.find(route => route.routeId === routeId && route.provider === provider && route.model === model)?.groupId ?? null : null;
  const contractRow = (routeId: string, model: string): StoredServingContract | undefined =>
    contracts.find(row => row.routeId === routeId && row.model === model);
  const keyFromRow = (row: StoredServingContract | undefined) => row && row.auth === "stored" && row.apiKey ? { routeId: row.routeId, model: row.model } : null;
  const api = (task: AiTaskDef, model: string, provider: string, origin: string, baseUrl: string | null, extra: Partial<AiCurrentUse> = {}): AiCurrentUse =>
    Object.freeze({ kind: "api", baseUrl, cliTool: null, model, provider, origin, deviceId: groupOf(task.routeId, provider, model), keyFrom: null, ...extra });
  const cli = (task: AiTaskDef, provider: string, model: string, origin: string, extra: Partial<AiCurrentUse> = {}): AiCurrentUse =>
    Object.freeze({ kind: "cli", baseUrl: null, cliTool: aiCliToolOfProvider(provider), model, provider, origin, deviceId: groupOf(task.routeId, provider, model),
      keyFrom: null, ...extra });
  /** 1차·2차 심사자 한 명 → 쓰는 서버(엔진 직접 계약의 endpoint). 계약이 없으면 주소를 모른다. */
  const reviewer = (task: AiTaskDef, value: { provider: string; model: string }, origin: string): AiCurrentUse => {
    if (value.provider.endsWith("-cli")) return cli(task, value.provider, value.model, origin);
    const routeId = task.routeId!;
    if (value.provider === "local-direct") {
      const contract = task.id === "second-review" ? resolveAi2GatewayServingContract(value.model, "local-direct") : resolveAi1GatewayServingContract(value.model, "local-direct");
      const row = contractRow(routeId, value.model);
      const endpoint = baseOf(field(contract, "endpoint"));
      return api(task, value.model, "local-direct", origin, endpoint, { keyFrom: keyFromRow(row), ...(endpoint ? {} : { note: "local-direct 계약 없음" }) });
    }
    const row = contractRow(routeId, value.model);
    const endpoint = row?.transport === "direct" ? baseOf(field(row.contract, "endpoint")) : null;
    return api(task, value.model, "abcllm", origin, endpoint, { keyFrom: keyFromRow(row), ...(endpoint ? {} : { note: "엔진 직접 계약 없음(지금 호출이 미뤄집니다)" }) });
  };
  const slot = (task: AiTaskDef, value: Partial<AiCurrentSlot> & Pick<AiCurrentSlot, "source">, index = 1): AiCurrentSlot =>
    Object.freeze({ task: task.id, slot: index, uses: Object.freeze([...value.uses ?? []]), source: value.source, error: value.error ?? null, skip: value.skip ?? null,
      notes: Object.freeze([...value.notes ?? []]) });
  const tableRows = (stage: AssignmentStage | null, stageId: AdminModelStage) => {
    if (!sources.tableOn || !stage) return null;
    const rows = stageAssignmentRows(stage)?.filter(row => row.role === "primary" && row.mode === "live") ?? [];
    if (!rows.length) return null;
    const registry = readModelRegistry(process.env);
    const eligible = rows.filter(row => tableStageSelections(
      target => target === stage ? [row] : null, `ai-task-current:${stageId}`, registry)[stageId] === row.registryKey);
    if (!eligible.length) return null;
    const rank = Math.min(...eligible.map(row => row.rank));
    return eligible.filter(row => row.rank === rank)
      .sort((a, b) => a.rank - b.rank || a.assignmentId.localeCompare(b.assignmentId));
  };
  const pools = sources.settings.stageModelPools ?? {};
  const humanTable = (() => {
    try { return tableRows("human", "human-review"); }
    catch { return null; }
  })();
  const effectivePools = humanTable
    ? Object.fromEntries(Object.entries(pools).filter(([id]) => id !== "human-review")) as typeof pools
    : pools;
  /** 직접 모델 단계(단계 풀 → 같은 용도의 공통 풀 → 등록부·env 기본값). 풀 key 마다 그 key 하나로 좁힌 범위에서 실제 고르기 함수를 부른다. */
  const stageUses = (task: AiTaskDef, read: () => { model: string; baseUrl: string | null; provider: string; cliEngine?: CliEngineSource } | null, provider: string): AiCurrentSlot => {
    const stageId = task.adminStage as AdminModelStage | null;
    if (!stageId) return slot(task, { source: "—", error: "stage_unmapped" });
    if (sources.settingsUnknown) return slot(task, { source: "설정 출처 미확인", error: "settings_unavailable" });
    // 같은 용도를 나누는 단계(감사·갈림·보류 → direct-review, 갈림 확인 → human-review)는 자기 풀이 없으면 그 용도의 공통 풀을 쓴다(withAdminModelStage 와 같다)
    const purpose = ADMIN_MODEL_STAGES.find(stage => stage.id === stageId)?.purpose ?? stageId;
    if (sources.tableUnknown && (task.assignmentStage || (!(pools[stageId]?.length) && purpose !== stageId && !!ADMIN_STAGE_ASSIGNMENTS[purpose]))) return slot(task, { source: "배정 출처 미확인", error: "assignments_unavailable" });
    const rawStage = task.assignmentStage as AssignmentStage | null;
    const table = tableRows(rawStage, stageId);
    const own = pools[stageId] ?? [];
    const sharedTable = !table && !own.length ? tableRows(ADMIN_STAGE_ASSIGNMENTS[purpose] ?? null, purpose as AdminModelStage) : null;
    const shared = purpose !== stageId ? pools[purpose as AdminModelStage] ?? [] : [];
    const selectedTable = table ?? sharedTable;
    const keys = selectedTable ? selectedTable.map(row => row.registryKey) : own.length ? own : shared;
    const scopeStage = table || own.length ? stageId : purpose;
    const poolOf = (key: string) => ({ ...effectivePools, [scopeStage]: [key] });
    const selectedRead = () => {
      const value = read();
      if (!value) return null;
      const definition = modelForPurpose(purpose);
      return definition.cliEngine && modelRequestName(definition) === value.model
        ? { ...value, provider: "opencode-cli", cliEngine: definition.cliEngine } : value;
    };
    const run = (scope: Record<string, string[]> | null) => scope
      ? withAdminStagePools(scope, `ai-task-current:${stageId}`, () => withAdminModelStage(stageId, selectedRead)) : selectedRead();
    try {
      const picked = keys.length ? keys.map((key, index) => ({ origin: table ? `배정 표 ${stageId} rank ${table[index].rank}` : own.length
        ? `stageModelPools.${stageId}[${index}]` : sharedTable ? `공통 단계 배정 표 ${purpose} rank ${sharedTable[index].rank}`
        : `stageModelPools.${purpose}[${index}]`, value: run(poolOf(key)) })) : [{ origin: "등록부·env 기본값", value: run(null) }];
      const uses = picked.flatMap(({ value, origin }) => !value ? [] : [value.cliEngine
        ? cli(task, "opencode-cli", value.model, origin, { baseUrl: value.baseUrl,
            options: value.cliEngine.reasoningEffort ? { reasoningEffort: value.cliEngine.reasoningEffort } : {} })
        : value.provider.endsWith("-cli") ? cli(task, value.provider, value.model, origin)
        : api(task, value.model, provider, origin, value.baseUrl)]);
      const notes = !table && !sharedTable && keys.length > 1 ? ["작업 묶음마다 모델 하나를 선택합니다."] : [];
      return slot(task, { uses, source: table ? "배정 표" : own.length ? "단계 풀" : sharedTable ? "공통 단계 배정 표" : shared.length ? "공통 단계 풀" : "등록부·env 기본값", notes });
    } catch (error) { return slot(task, { source: "—", error: errorText(error) }); }
  };
  const purposeRead = (purpose: string, provider: string) => () => {
    const model = purpose in MODEL_PURPOSE_ENV ? configuredModel(purpose as keyof typeof MODEL_PURPOSE_ENV) : modelRequestName(modelForPurpose(purpose));
    let baseUrl: string | null = null;
    try { baseUrl = modelBaseUrl(purpose); } catch { baseUrl = null; }
    return { model, baseUrl: provider.endsWith("-cli") ? null : baseOf(baseUrl), provider: modelForPurpose(purpose).provider.endsWith("-cli") ? modelForPurpose(purpose).provider : provider };
  };

  const out: AiCurrentSlot[] = [];
  for (const task of AI_TASKS) {
    try {
      switch (task.id) {
        case "first-review": {
          // 가져오기 출처 = 옛 설정(PR C1 부터 실행 쪽은 작업 ↔ 모델 순위만 읽는다 — 이 칸은 순위를 처음 채우는 데만 쓴다). 화면의 「지금 실제로 쓰는 모델」은
          // 저장한 순위다(admin-ai-tasks-repository live 줄).
          const pool = legacyFirstReviewers(sources.settings);
          out.push(slot(task, { source: "옛 설정 firstReview · firstReviewAdditional(가져오기 출처)", uses: pool.map((row, index) =>
            reviewer(task, row, index === 0 ? "firstReview" : `firstReviewAdditional[${index - 1}]`)),
            ...(pool.length ? {} : { skip: "옛 설정에 1차 심사자가 없습니다." }) }));
          break;
        }
        case "second-review": {
          // 가져오기 출처 = 옛 설정 voters·fallbacks. 옛 대체 목록은 투표자 모두가 나눠 썼다 — 순위로 옮기면 칸마다 따로라, 같은 대체 모델을 두 칸에 넣으면
          // 한 항목에 같은 모델이 두 표를 낼 수 있다. 그래서 대체 모델은 그것을 받을 수 있는 첫 칸에만 넣고 다음 칸에서는 뺀다(경고). 투표자와 같은 모델의 대체도 뺀다.
          const voters = sources.settings.secondReview.voters, fallbacks = sources.settings.secondReview.fallbacks ?? [];
          const placed = new Set<string>(voters.map(voter => underlyingReviewModel(voter.model)));
          for (let index = 1; index <= task.slots; index++) {
            const voter = voters[index - 1];
            if (!voter) { out.push(slot(task, { source: "옛 설정 secondReview(가져오기 출처)", skip: `투표자 ${index}이(가) 없습니다.` }, index)); continue; }
            const notes: string[] = [];
            const mine = fallbacks.map((row, at) => ({ row, at })).filter(entry => {
              const key = underlyingReviewModel(entry.row.model);
              if (key === underlyingReviewModel(voter.model) || voters.some(other => underlyingReviewModel(other.model) === key)) {
                notes.push(`대체 ${entry.row.model}은(는) 투표자와 같은 모델이라 옮기지 않습니다.`); return false;
              }
              if (placed.has(key)) { notes.push(`대체 ${entry.row.model}은(는) 앞 투표자 칸의 2·3순위로만 옮깁니다 — 한 모델이 한 항목에 두 표를 내지 않게 이 칸에서는 뺍니다.`); return false; }
              return true;
            }).slice(0, 2);
            for (const entry of mine) placed.add(underlyingReviewModel(entry.row.model));
            out.push(slot(task, { source: "옛 설정 secondReview(가져오기 출처)", uses: [reviewer(task, voter, `secondReview.voters[${index - 1}]`),
              ...mine.map(entry => reviewer(task, entry.row, `secondReview.fallbacks[${entry.at}]`))],
              notes: [...(mine.length ? ["2·3순위는 옛 2차 대체 목록입니다 — 순위로 옮기면 이 칸의 투표자가 쓸 수 없을 때만 이 칸의 표를 냅니다."] : []), ...notes] }, index));
          }
          break;
        }
        case "crawl-tagline": case "reason-translate": case "product-translate": case "product-tagline-ko": case "search-query-translate":
        case "product-search-profile": case "product-search-verify": {
          // PR B: 실행 쪽이 이 표(작업 ↔ 모델)를 읽는다 — 지금 쓰는 모델 = 저장한 순위. 쓸 수 없는 순위는 그 까닭을 붙인다.
          const resolution = resolveTextTaskRanks(task.id as AiTextTaskId);
          // 순위가 아직 없으면(배포 직후·가져오기 전) 가져오기 출처는 이 경로의 켜진 엔진 직접 계약이다 — PR B 전에도 text 경로는 이 계약으로만 열렸다.
          // 정확히 하나일 때만 옮긴다(둘 이상이면 어느 것이 1순위인지 지어내지 않고 건너뛴다). 실행 쪽은 순위가 생길 때까지 no_task_models 로 멈춰 있다.
          if (resolution.status === "no_task_models") {
            const own = contracts.filter(row => row.routeId === task.routeId && row.transport === "direct" && !row.model.includes("@"));
            const endpoint = own.length === 1 ? baseOf(field(own[0].contract, "endpoint")) : null;
            if (own.length === 1 && endpoint) {
              out.push(slot(task, { source: "켜진 엔진 직접 계약(순위 없음 — 가져오기 출처)", uses: [api(task, own[0].model, "abcllm", `${task.routeId} 계약`, endpoint,
                { keyFrom: keyFromRow(own[0]) })],
                notes: ["작업 ↔ 모델에 순위가 없어 지금 이 작업은 돌지 않습니다(no_task_models) — 가져오기가 이 계약을 1순위로 옮깁니다."] }));
              break;
            }
          }
          out.push(slot(task, { source: "작업 ↔ 모델(실행 쪽이 이 표를 읽는다)", uses: resolution.candidates.map(candidate => {
            const extra = { baseUrl: candidate.rank.connection.baseUrl, deviceId: candidate.rank.connection.deviceId,
              options: candidate.rank.options, ...(candidate.unusable ? { note: textRankUnusableText(candidate.unusable) } : {}) };
            return candidate.rank.connection.kind === "cli"
              ? cli(task, "opencode-cli", candidate.rank.model, `작업 ↔ 모델 ${candidate.rank.rank}순위`, extra)
              : api(task, candidate.rank.model, candidate.binding?.provider ?? "abcllm", `작업 ↔ 모델 ${candidate.rank.rank}순위`, candidate.rank.connection.baseUrl, extra);
          }),
            ...(resolution.status === "ok" ? {} : { skip: resolution.status === "no_task_models"
              ? "작업 ↔ 모델에 순위가 없습니다 — 이 작업은 돌지 않습니다(no_task_models). 기본값으로 대신 부르지 않습니다."
              : "작업 ↔ 모델 표를 아직 읽지 못했습니다(task_models_unreadable)." }) }));
          break;
        }
        case "korean-translation-direct":
          out.push(koreanTranslationQwenEnabled(sources.env) ? stageUses(task, purposeRead("korean-translation-direct", "local-direct"), "local-direct")
            : slot(task, { source: "env KOREAN_TRANSLATION_QWEN_ENABLED", skip: "지금 꺼져 있습니다(KOREAN_TRANSLATION_QWEN_ENABLED) — 켜지 않은 경로는 옮기지 않습니다." }));
          break;
        case "human-review": {
          const slot = stageUses(task, purposeRead("human-review", "local-direct"), "local-direct");
          const note = sources.settings.humanReview.enabled ? "자동 위임 켜짐" : "자동 위임 꺼짐 · 사람이 직접 판단";
          out.push(Object.freeze({ ...slot, notes: Object.freeze([...slot.notes, note]) }));
          break;
        }
        case "split-confirm":
          out.push(stageUses(task, purposeRead("human-review", "local-direct"), "local-direct"));
          break;
        case "audit-review": case "audit-second-opinion": case "published-filter": case "split-tiebreak": case "held-review-retry": {
          const value = stageUses(task, () => {
            const config = qwenDirectConfig();
            return config ? { model: config.model, baseUrl: baseOf(config.baseUrl), provider: "local-direct" } : null;
          }, "local-direct");
          const keyed = sources.env.AUDIT_SECOND_OPINION_API_KEY?.trim();
          out.push(keyed ? { ...value, uses: value.uses.map(use => ({ ...use, note: "키는 env AUDIT_SECOND_OPINION_API_KEY — 가져오기가 옮깁니다", keyEnv: "AUDIT_SECOND_OPINION_API_KEY" })) } : value);
          break;
        }
        case "screen-review": {
          const value = stageUses(task, () => {
            const config = screenModelConfig();
            return config ? { model: config.model, baseUrl: baseOf(config.baseUrl), provider: "local-direct" } : null;
          }, "local-direct");
          const keyEnv = sources.env.SCREEN_REVIEW_MODEL_API_KEY?.trim() ? "SCREEN_REVIEW_MODEL_API_KEY" : sources.env.AUDIT_SECOND_OPINION_API_KEY?.trim()
            ? "AUDIT_SECOND_OPINION_API_KEY" : null;
          out.push(keyEnv ? { ...value, uses: value.uses.map(use => ({ ...use, keyEnv })) } : value);
          break;
        }
        case "assist-review": case "assist-audit": {
          const lane = task.id === "assist-audit" ? "audit" : "regular";
          if (!sources.env.LLM_ASSIST_BACKENDS) { out.push(slot(task, { source: "env LLM_ASSIST_BACKENDS", skip: "LLM_ASSIST_BACKENDS 가 없어 지금 돌지 않습니다." })); break; }
          const drains = withAdminStagePools(pools, `ai-task-current:${task.id}`, () => assistBackendDrains(process.env, lane));
          out.push(slot(task, { source: "env LLM_ASSIST_BACKENDS + 로컬 계약", uses: drains.map(drain => {
            const source = parseCliEngineRevision(drain.contract.deploymentRevision);
            const extra = { baseUrl: baseOf(drain.contract.endpoint), deviceId: drain.contract.physicalGroup,
              ...(source?.reasoningEffort ? { options: { reasoningEffort: source.reasoningEffort } } : {}) };
            return source ? cli(task, "opencode-cli", drain.contract.model, `LLM_ASSIST_BACKENDS ${drain.backendId}`, extra)
              : api(task, drain.contract.model, "local-direct", `LLM_ASSIST_BACKENDS ${drain.backendId}`, extra.baseUrl, extra);
          }),
            notes: sources.env.LLM_ASSIST_API_KEYS ? ["보강 키(LLM_ASSIST_API_KEYS)는 옮기지 않습니다 — 키가 필요한 엔진이면 연결에 키를 넣으세요."] : [],
            ...(drains.length ? {} : { skip: "이 줄의 보강 장비가 없습니다." }) }));
          break;
        }
        case "product-audit": {
          const audit = sources.auditCampaign;
          if (!audit) { out.push(slot(task, { source: "product_audit_campaigns", skip: "실행 중인 감사가 없습니다 — 새 감사는 시작할 때 고른 모델로 굳습니다." })); break; }
          const config = audit.provider === QWEN_AUDIT_PROVIDER ? qwenDirectConfig() : null;
          const use = audit.provider.endsWith("-cli") ? cli(task, audit.provider, audit.model, "실행 중인 감사")
            : audit.provider === QWEN_AUDIT_PROVIDER ? api(task, audit.model, QWEN_AUDIT_PROVIDER, "실행 중인 감사", baseOf(config?.baseUrl))
              : reviewer({ ...task, routeId: "crawl-agent-review" } as AiTaskDef, audit, "실행 중인 감사");
          out.push(slot(task, { source: "실행 중인 감사 캠페인", uses: [use] }));
          break;
        }
        case "product-intro-check":
          out.push(stageUses(task, purposeRead("product-intro-check", "claude-cli"), "claude-cli"));
          break;
        case "publish-classify": {
          const agent = sources.agent;
          if (!agent?.config) { out.push(slot(task, { source: "connect 에이전트", error: "connect 에이전트 설정을 읽지 못했습니다" })); break; }
          const rows = [agent.config.primary, agent.config.fallback].filter((row): row is NonNullable<typeof row> => !!row);
          out.push(slot(task, { source: "connect 에이전트 설정", uses: rows.map((row, index) => {
            const provider = knownClassificationProvider(row.model, agent.modelOptions) ?? "codex-cli";
            return cli(task, provider, row.model, index === 0 ? "connect 설정 primary" : "connect 설정 fallback", { options: row.effort ? { effort: row.effort } : {} });
          }) }));
          break;
        }
        case "grok-session-check": {
          // 가져오기 출처 = 옛 1·2차 설정의 Grok 심사자(PR C1 부터 잡은 이 작업의 순위만 읽는다)
          const review = sources.settings.secondReview;
          const grok = [...review.voters, ...review.fallbacks ?? [], ...legacyFirstReviewers(sources.settings)].find(row => row.provider === "grok-cli");
          out.push(grok ? slot(task, { source: "옛 설정의 Grok 심사자(가져오기 출처)", uses: [cli(task, "grok-cli", grok.model, "Grok 심사자")] })
            : slot(task, { source: "옛 설정의 Grok 심사자(가져오기 출처)", skip: "옛 설정에 Grok 심사자가 없습니다." }));
          break;
        }
        case "product-embedding": case "search-embedding": case "search-rerank": {
          const name = task.id === "search-rerank" ? "RERANK_URL" : "EMBEDDING_URL";
          if (sources.searchModels) {
            const value = sources.searchModels[task.id];
            if (!value || value.error) {
              out.push(slot(task, { source: "검색 API 설정", error: "search_model_unavailable" }));
              break;
            }
            if (value.source === "environment" && !value.baseUrl) {
              out.push(slot(task, { source: "환경 API 설정", skip: `환경 API 설정에 ${name} 이(가) 없어 옮기지 않습니다.`, uses: [] }));
              break;
            }
            if (!value.baseUrl || (!value.model && value.source !== "environment")) {
              out.push(slot(task, { source: "검색 API 설정", error: "search_model_unavailable" }));
              break;
            }
            const source = value.source === "environment" ? "환경 API 설정" : "검색 API 설정";
            const model = value.model ?? (task.kind === "embedding" ? EMBEDDING_MODEL : "서버 제공 모델");
            out.push(slot(task, { source, uses: [api(task, model, "llama-server", source, baseOf(value.baseUrl), { serverNamed: value.source === "environment" })] }));
            break;
          }
          const base = baseOf(sources.env[name]?.trim());
          out.push(base ? slot(task, { source: `웹 프로세스 env ${name}`, uses: [api(task, task.kind === "embedding" ? EMBEDDING_MODEL : "rerank", "llama-server", `env ${name}`, base,
            { serverNamed: true, note: "모델 이름은 서버 목록에서 고릅니다(하나뿐이면 그것)" })],
            notes: task.id === "product-embedding" ? ["웹 프로세스의 EMBEDDING_URL 입니다 — 잡(워커)의 값이 다르면 다를 수 있습니다."] : [] })
            : slot(task, { source: `웹 프로세스 env ${name}`, skip: `웹 프로세스에 ${name} 이(가) 없어 옮기지 않습니다.` }));
          break;
        }
        default:
          out.push(slot(task, { source: "—", error: "task_unmapped" }));
      }
    } catch (error) { out.push(slot(task, { source: "—", error: errorText(error) })); }
  }
  return out;
}

/** 현재 값의 출처를 모아(설정·text 경로 이름·정책·connect 상태·실행 중 감사·배정 표 스위치) buildAiCurrentSlots 에 넘긴다. 읽기만 한다. */
export async function readAiCurrentSources(policy: ModelCapacityPolicy | null, options: { includeAgent?: boolean } = {}): Promise<AiCurrentSources> {
  await Promise.all([ensureServingContracts(0), ensureAiTaskModels(0)]);
  const [{ getSettings, settingsUnreadable }, { currentModelEnv }, { agentRequest }, { resolveSearchModelSettings }] = await Promise.all([import("@/lib/crawl/settings"), import("./model-env"), import("./agent-client"), import("@/lib/domain/products/search-model-settings")]);
  const [settings, modelEnv, agent, auditCampaign, flag] = await Promise.all([onPrimary(getSettings), currentModelEnv(),
    options.includeAgent === false ? Promise.resolve(null) : agentRequest<AgentStatus>("status").catch(() => null),
    onPrimary(async () => {
      const [row] = await db.select({ provider: productAuditCampaigns.provider, model: productAuditCampaigns.model, currentProvider: productAuditCampaigns.currentProvider,
        currentModel: productAuditCampaigns.currentModel }).from(productAuditCampaigns).where(eq(productAuditCampaigns.status, "running")).limit(1);
      return row ? row.currentProvider && row.currentModel ? { provider: row.currentProvider, model: row.currentModel } : { provider: row.provider, model: row.model } : null;
    }).catch(() => null),
    ensureStageAssignments(0).then(assignmentFlagState).catch(() => ({ enabled: false, source: "unread" }))]);
  const searchModels = Object.freeze(Object.fromEntries(await Promise.all((["product-embedding", "search-embedding", "search-rerank"] as const).map(async task => {
    try {
      const value = await resolveSearchModelSettings(task);
      return [task, Object.freeze({ source: value.source, model: value.model, baseUrl: value.baseUrl, error: null })] as const;
    } catch {
      return [task, Object.freeze({ source: "검색 API 설정", model: null, baseUrl: null, error: "search_model_unavailable" })] as const;
    }
  }))));
  return { settings, modelEnv, policy, agent, auditCampaign, tableOn: flag.enabled === true, tableUnknown: flag.source === "unread", settingsUnknown: settingsUnreadable(settings), searchModels, env: process.env };
}
