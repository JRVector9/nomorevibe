import type { FirstReviewer } from "@/lib/crawl/agent-review";
import { modelRequestName, type ModelDefinition } from "@/lib/llm/model-registry";
import type { ServedContractModels } from "./admin-engine-connect";

/**
 * 단계 × 모델 순위(2026-11-01 운영자 결정) — 「1차 AI 검수」(crawl-agent-review)의 1·2·3순위 선택지·검증·준비 확인.
 * 저장소는 따로 만들지 않는다: 배정 표가 꺼져 있으면 설정 풀(firstReview = 1순위, firstReviewAdditional = 2·3순위), 켜져 있으면
 * /admin/models/assignments 의 rank 칸이다. 실행 쪽 규칙은 lib/crawl/first-reviewers.ts selectFirstReviewer(순위 대체)다.
 * 다른 단계(2차·text 경로)도 같은 모양(stage·routeId·providers)으로 이 모듈을 쓸 수 있게 단계 정의를 값으로 둔다.
 * 순수 모듈이다(화면 구성 요소가 읽는다) — DB 를 읽는 준비 확인 입력은 admin-first-review-ranks-read.ts 에 있다.
 */
export type RankStage = Readonly<{ id: string; label: string; routeId: string; providers: readonly FirstReviewer["provider"][]; slots: number }>;
export const FIRST_REVIEW_RANK_STAGE: RankStage = Object.freeze({ id: "first-review", label: "1차 AI 검수", routeId: "crawl-agent-review",
  // AI1 이 부를 수 있는 공급자(first-reviewers.ts firstReviewCandidates 와 같다). codex-cli 는 1차 심사자로 받지 않는다.
  providers: Object.freeze(["abcllm", "local-direct", "claude-cli", "grok-cli"] as const), slots: 3 });

export type RankOption = Readonly<{ provider: FirstReviewer["provider"]; model: string; server: string; label: string; saved?: boolean }>;
type ContractRow = Readonly<{ routeId: string; model: string; contract: unknown; transport: string }>;
const contractProvider = (row: ContractRow | undefined): FirstReviewer["provider"] | null => {
  const provider = row && row.contract && typeof row.contract === "object" ? (row.contract as { provider?: unknown }).provider : undefined;
  return provider === "local-direct" ? "local-direct" : row ? "abcllm" : null;
};
/**
 * 드롭다운 <option value> 에 그대로 들어가는 열쇠. 두 칸을 encodeURIComponent 해 「/」로 잇는다 — 결과에는 영숫자·`-_.!~*'()%/` 만 남아 HTML 이 바꾸지 않는다.
 * 예전 NUL(U+0000) 구분자는 서버가 그린 HTML 을 브라우저가 읽을 때 U+FFFD 로 바뀌어(HTML 파서 규칙) 고른 값이 선택지와 맞지 않았다 → 드롭다운이 늘 「없음」으로
 * 돌아가고 그대로 저장하면 순위가 비워졌다(2026-11-02 1차 AI 검수·소개 검수 순위가 지워짐). 두 칸 모두 「/」를 품지 않으므로 서로 다른 값이 같은 열쇠가 되지 않는다.
 */
export const rankOptionKey = (row: { provider: string; model: string }) => `${encodeURIComponent(row.provider)}/${encodeURIComponent(row.model)}`;

/**
 * 선택지: 지금 모든 서버가 실제로 내놓는 모델(엔진 API GET /models — readServedContractModels, 화면이 이미 한 번 읽은 결과) + 이 단계가 받는 CLI 제공자 모델.
 * 표시는 「장비 · 모델」. 엔진 모델의 공급자는 이 단계 경로의 저장된 연결 계약을 따르고(abcllm 형 직접 연결 또는 local-direct), 계약이 없으면 local-direct 다 —
 * 그 경우 저장 뒤 준비 확인이 무엇이 없는지 알린다. 지금 저장된 값이 목록에 없으면 「(저장된 값)」으로 남겨 저장 누락으로 지우지 않는다.
 */
export function rankOptions(stage: RankStage, input: { served: readonly ServedContractModels[]; contracts: readonly ContractRow[];
  registry: readonly ModelDefinition[]; current: readonly (FirstReviewer | null | undefined)[] }): RankOption[] {
  const byKey = new Map<string, { provider: FirstReviewer["provider"]; model: string; servers: string[]; saved?: boolean }>();
  const add = (provider: FirstReviewer["provider"], model: string, server: string, saved = false) => {
    if (!stage.providers.includes(provider) || !model.trim()) return;
    const key = rankOptionKey({ provider, model }), row = byKey.get(key) ?? { provider, model, servers: [] };
    if (!row.servers.includes(server)) row.servers.push(server);
    if (saved) row.saved = true;
    byKey.set(key, row);
  };
  for (const served of input.served) for (const id of served.servedIds ?? []) {
    const contract = input.contracts.find(row => row.routeId === stage.routeId && row.model === id);
    add(contractProvider(contract) ?? "local-direct", id, served.equipment ?? served.host ?? "엔진");
  }
  for (const model of input.registry)
    if ((model.provider === "claude-cli" || model.provider === "grok-cli") && stage.providers.includes(model.provider))
      add(model.provider, modelRequestName(model), model.provider);
  for (const row of input.current) if (row && !byKey.has(rankOptionKey(row))) add(row.provider, row.model, "저장된 값", true);
  return [...byKey.values()].map(row => Object.freeze({ provider: row.provider, model: row.model, server: row.servers.join(", "),
    label: `${row.servers.join(", ")} · ${row.model}${row.saved ? " (저장된 값 · 지금 목록에 없음)" : ""}`, ...(row.saved ? { saved: true } : {}) }))
    .sort((a, b) => Number(a.provider.endsWith("-cli")) - Number(b.provider.endsWith("-cli")) || a.label.localeCompare(b.label));
}

/** 1·2·3순위 검증(순수). 빈 칸은 「없음」. 반복 모델도 실제 실행의 공유 용량 한도를 따른다. */
export function validateRanks(stage: RankStage, ranks: readonly (FirstReviewer | null)[]): string[] {
  const issues: string[] = [];
  if (ranks.length > stage.slots) issues.push(`${stage.label}은 ${stage.slots}순위까지 고를 수 있습니다.`);
  const firstEmpty = ranks.findIndex(row => !row);
  if (firstEmpty >= 0 && ranks.slice(firstEmpty + 1).some(Boolean))
    issues.push(`${firstEmpty + 1}순위를 비우고 그 뒤 순위만 고를 수 없습니다. ${firstEmpty + 1}순위부터 차례로 골라주세요.`);
  ranks.forEach((row, index) => {
    if (!row) return;
    if (!stage.providers.includes(row.provider)) issues.push(`${index + 1}순위: ${stage.label}에서 쓸 수 없는 제공자입니다(${row.provider}).`);
  });
  return issues;
}

export type PolicyRoute = { routeId: string; provider: string; model: string; groupId?: string };
/**
 * 저장한 순위가 실제로 쓰일 수 있는지(읽기만 한다). 없는 것을 한국어로 알린다 — 실행 쪽은 그런 순위를 「쓸 수 없음」으로 보고 다음 순위로 넘어간다.
 * 연결 계약·용량 경로·장비 한도는 여기서 만들지 않는다: 계약은 엔진 probe·키가 필요한 「엔진 연결」이, 경로·장비는 운영자의 용량 정책·장비 화면이 만든다.
 */
export function rankReadiness(stage: RankStage, ranks: readonly (FirstReviewer | null)[], input: { contracts: readonly ContractRow[];
  capacity: { mode: string; routes: readonly PolicyRoute[]; devices: ReadonlyMap<string, boolean>; groupLimits: Readonly<Record<string, unknown>> } | null }): string[] {
  const warnings: string[] = [];
  ranks.forEach((row, index) => {
    if (!row) return;
    const name = `${index + 1}순위 ${row.provider} · ${row.model}`;
    if ((row.provider === "abcllm" || row.provider === "local-direct")
      && !input.contracts.some(contract => contract.routeId === stage.routeId && contract.model === row.model))
      warnings.push(`${name}: ${stage.label}(${stage.routeId}) 연결 계약이 없습니다. 「엔진 연결」에서 이 모델을 ${stage.routeId} 경로로 연결해야 이 순위가 쓰입니다.`);
    if (input.capacity === null) { warnings.push(`${name}: 용량 정책을 읽지 못해 경로·장비 준비를 확인하지 못했습니다.`); return; }
    if (input.capacity.mode === "disabled") return;
    const route = input.capacity.routes.find(item => item.routeId === stage.routeId && item.provider === row.provider && item.model === row.model);
    if (!route) { warnings.push(`${name}: 용량 정책에 ${stage.routeId} / ${row.provider} / ${row.model} 경로가 없습니다. 경로와 장비 한도를 추가해야 이 순위가 쓰입니다(그 전에는 다음 순위로 넘어갑니다).`); return; }
    const device = route.groupId ? input.capacity.devices.get(route.groupId) : true;
    if (route.groupId && device === false)
      warnings.push(`${name}: 장비 ${route.groupId}가 꺼져 있습니다. 장비 화면에서 켜야 이 순위가 쓰입니다.`);
    else if (route.groupId && device === undefined && input.capacity.groupLimits[route.groupId] === undefined)
      warnings.push(`${name}: 장비 ${route.groupId} 한도가 설정되지 않았습니다. 장비 화면에서 한도를 추가해야 이 순위가 쓰입니다.`);
  });
  return warnings;
}
