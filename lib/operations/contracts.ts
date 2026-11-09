import { classificationDefaultConfig, classificationModelOptions, type ClassificationModelOption } from "./classification-models";
import type { CliServingContract } from '@/lib/llm/cli-serving-contract';
import { z } from 'zod';
import { categoryDefinitionsSchema } from '@/lib/crawl/settings-schema';
import { publicationClassifyInputSchema, publicationPublisherRoleSchema } from '@/lib/llm/publication-classify-contract';
export const CLASSIFICATION_MODEL_OPTIONS = classificationModelOptions();
export const MODEL_IDS = CLASSIFICATION_MODEL_OPTIONS.map(option => option.model);
export function modelConfigSchemaFor(options: readonly ClassificationModelOption[]) {
  const model = z.object({ model: z.string().refine(value => options.some(option => option.model === value), '설정에 없는 모델입니다.'),
    effort: z.enum(['high', 'xhigh']) }).strict().refine(value => options.find(option => option.model === value.model)?.provider !== 'claude-cli'
      || value.effort === 'high', 'Claude는 high 강도를 사용합니다.');
  return z.object({ primary: model, fallback: model.nullable() }).strict()
    .refine(value => value.primary.model !== value.fallback?.model, '우선·예비 모델이 같습니다.');
}
// Restore a safely shaped old selection without executing it or silently replacing it after a registry change.
const storedModel = z.object({ model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/), effort: z.enum(['high', 'xhigh']) }).strict();
export const storedModelConfigSchema = z.object({ primary: storedModel, fallback: storedModel.nullable() }).strict();
export const modelConfigSchema = modelConfigSchemaFor(CLASSIFICATION_MODEL_OPTIONS);
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export const DEFAULT_CONFIG: ModelConfig = classificationDefaultConfig();
export const classifyInputsSchema = z.array(z.object({
  repo: z.string().max(200), url: z.string().max(2000), name: z.string().max(300),
  tagline: z.string().max(2000), topics: z.array(z.string().max(200)).max(100), language: z.string().max(100).nullable(),
  readme: z.string().max(6000).optional(),
}).strict()).min(1).max(10);
/**
 * 분류 요청 본문.
 *
 * definitions는 선택이다. 웹과 연결 서비스는 따로 배포되므로 한쪽이 옛 버전일 수 있고,
 * 그때는 연결 서비스의 코드 기본값으로 도는 것이 분류가 멈추는 것보다 낫다.
 */
export const classifyPayloadSchema = z.object({
  inputs: classifyInputsSchema,
  definitions: categoryDefinitionsSchema.optional(),
  authority: publicationClassifyInputSchema.omit({ provider: true, model: true }).extend({
    version: z.literal(1), publisherRole: publicationPublisherRoleSchema,
    job: z.object({ name: z.literal('crawl-publish'), token: z.uuid(), requestedVersion: z.number().int().nonnegative().safe() }).strict(),
  }).strict().optional(),
}).strict();
export type ClassificationAuthority = NonNullable<z.infer<typeof classifyPayloadSchema>['authority']>;
export const JOB_LABELS: Record<string, string> = {
  'product-llm-assist-review': '근거 보강·LLM 확인',
  'product-llm-assist-audit-review': '보강의 독립 모델 감사',
  'product-automated-action-audit': '자동 조치 표본 선정',
  'github-integration-reconcile': 'GitHub 연동 재조회',
  'github-feedback-delivery': 'GitHub 피드백 전송',
  'email-outbox-send': '알림 메일 보내기', 'email-weekly-digest': '주간 요약 메일 묶기',
  'human-deepseek-review': 'DeepSeek 사람 검토', 'held-qwen-retry': '보류 Qwen 재심사', 'split-confirm': '갈림 DeepSeek 확인',
  'split-tiebreak': '2차 갈림 판가름', 'audit-qwen': 'Qwen 직접 감사', 'audit-second-opinion': '감사 두 번째 의견', 'published-recheck': '공개분 변경 재검수',
  heartbeat: '스케줄러 관측', 'crawl-seed': '수집 대상 탐색', 'hn-show-seed': 'Show HN 수집', 'hn-talk': 'HN 화제 수집', 'bluesky-talk': 'Bluesky 화제 수집', 'crawl-fetch': '프로젝트 원본 수집',
  'crawl-judge': '규칙 심사', 'crawl-agent-review': 'AI 후보 심사', 'second-review': '2차 심사', 'reason-translate': '사유 번역', 'crawl-publish': '제품 분류·발행',
  'uptime-ping': '서비스 응답 점검', 'click-rollup': '유효 방문 집계', 'ranking-refresh': '랭킹 갱신',
  'product-evidence-refresh': '제품 근거 갱신', 'agent-evidence-refresh': '개발 AI 근거 갱신', 'news-refresh': 'AI 소식 수집',
  'product-thumbnail-refresh': '프로젝트 이미지 수집', 'product-audit': '발행분 감사', 'audit-screen-review': '화면 판별(감사)',
  'product-search-profile': '검색 키워드 짓기', 'product-search-verify': '검색 키워드 검수', 'grok-session-check': 'Grok 로그인 확인',
  'product-readme-refresh': 'README 갱신',
  'product-search-health': '검색 데이터 자동 점검',
  'product-intro-check': '소개 검수',
  'cdn-purge': 'CDN 캐시 지우기', 'crawl-tagline': '한 줄 소개 짓기', 'product-embedding': '의미 검색 벡터',
  'product-search-refresh': '검색 데이터 갱신', 'product-stars-refresh': 'GitHub 저장소·스타 확인',
  'product-star-observation': '8시간 스타 관측',
  'product-repo-review': '저장소 사라진 사이트 확인',
  'product-tagline-ko': '제품 소개 한국어 번역',
  'product-spam-rescan': '공개 제품 스팸 재검사',
  'product-translate': '제품 정보 번역', 'ai-level-refresh': 'AI 제작 단계 확인',
  'product-site-evidence-refresh': '공식 사이트 근거 갱신',
  'maker-recheck': '운영자 확인 재확인',
  'notification-delisted': '팔로 프로젝트 내려감 알림', 'notification-category-digest': '팔로 분야 주간 알림', 'notification-prune': '지난 알림 지우기', 'model-capacity-reclaim': '미확인 모델 요청 자동 해제',
};
export const ROLE_LABELS: Record<string, string> = { app: '웹·관리자 서비스', db: '데이터베이스', scheduler: '작업 일정 관리', crawler: '프로젝트 수집', reviewer: '후보 심사', publisher: '제품 발행', text: '소개·사유 번역', maintenance: '생존 확인·지표 집계', 'connect-agent': 'AI 연결·분류 실행',
  // 분리 역할(batch versioned) — 기존 역할의 잡을 떼어 Oracle 등 다른 host 에서 돈다
  translation: '번역', 'product-health': '서비스 응답 점검', 'site-evidence': '공식 사이트 근거', 'official-news': 'AI 소식 수집' };
export type AgentStatus = {
  modelOptions?: ClassificationModelOption[];
  defaultModelConfig?: ModelConfig;
  classificationCapacityVersion?: 1;
  classificationContracts?: readonly CliServingContract[];
  serverNow?: number;
  activity?: { id: string; kind: 'login' | 'oauth_exchange' | 'model'; startedAt: number; deadlineAt: number; model?: string } | null;
  accounts?: Partial<Record<'codex' | 'claude', { storedAt?: string; checkedAt?: string; result?: string; model?: string; probe?: { prompt: 'hi~'; reply?: string; result: string; model: string; checkedAt: string } }>>;
  configReady?: boolean;
  /** 지금 분류 요청을 받는가 — 적용한 설정과 계정이 있으면 true. 옛 연결 서비스는 보내지 않는다 */
  classifyReady?: boolean;
  connected: boolean; claudeConnected?: boolean; generation: number; configVersion: number; config: ModelConfig;
  busy: string | null; connection: { provider?: 'codex' | 'claude'; inputRequired?: boolean; error?: string; id: string; state: string; url?: string; code?: string; expiresAt: number } | null;
  verification: { id: string; state: string; config: ModelConfig; generation: number; results: Array<{ model: string; result: string }> } | null;
  lastAttempt: { model: string; result: string; at: string; generation: number; configVersion: number } | null;
  appliedAt: string | null; lastUsedVersion: number | null;
};
