import { z } from 'zod';
import { categoryDefinitionsSchema } from '@/lib/crawl/settings-schema';
export const MODEL_IDS = ['gpt-5.3-codex-spark', 'gpt-5.6-terra', 'sonnet'] as const;
const model = z.object({ model: z.enum(MODEL_IDS), effort: z.enum(['high', 'xhigh']) }).strict().refine(v => v.model !== 'sonnet' || v.effort === 'high', 'Claude는 high 강도를 사용합니다.');
export const modelConfigSchema = z.object({ primary: model, fallback: model.nullable() }).strict()
  .refine(v => v.primary.model !== v.fallback?.model, '우선·예비 모델이 같습니다.');
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export const DEFAULT_CONFIG: ModelConfig = { primary: { model: MODEL_IDS[0], effort: 'xhigh' }, fallback: { model: 'sonnet', effort: 'high' } };
export const classifyInputsSchema = z.array(z.object({
  repo: z.string().max(200), url: z.string().max(2000), name: z.string().max(300),
  tagline: z.string().max(2000), topics: z.array(z.string().max(200)).max(100), language: z.string().max(100).nullable(),
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
}).strict();
export const JOB_LABELS: Record<string, string> = {
  heartbeat: '스케줄러 관측', 'crawl-seed': '수집 대상 탐색', 'hn-show-seed': 'Show HN 수집', 'crawl-fetch': '프로젝트 원본 수집',
  'crawl-judge': '규칙 심사', 'crawl-agent-review': 'AI 후보 심사', 'crawl-publish': '제품 분류·발행',
  'uptime-ping': '서비스 응답 점검', 'click-rollup': '유효 방문 집계', 'ranking-refresh': '랭킹 갱신',
  'product-evidence-refresh': '제품 근거 갱신', 'agent-evidence-refresh': '개발 AI 근거 갱신',
};
export const ROLE_LABELS: Record<string, string> = { app: '웹·관리자 서비스', db: '데이터베이스', scheduler: '작업 일정 관리', crawler: '프로젝트 수집', reviewer: '후보 심사', publisher: '제품 발행', maintenance: '생존 확인·지표 집계', 'connect-agent': 'AI 연결·분류 실행' };
export type AgentStatus = {
  serverNow?: number;
  activity?: { id: string; kind: 'login' | 'oauth_exchange' | 'model'; startedAt: number; deadlineAt: number; model?: string } | null;
  accounts?: Partial<Record<'codex' | 'claude', { storedAt?: string; checkedAt?: string; result?: string; model?: string; probe?: { prompt: 'hi~'; reply?: string; result: string; model: string; checkedAt: string } }>>;
  configReady?: boolean;
  connected: boolean; claudeConnected?: boolean; generation: number; configVersion: number; config: ModelConfig;
  busy: string | null; connection: { provider?: 'codex' | 'claude'; inputRequired?: boolean; error?: string; id: string; state: string; url?: string; code?: string; expiresAt: number } | null;
  verification: { id: string; state: string; config: ModelConfig; generation: number; results: Array<{ model: string; result: string }> } | null;
  lastAttempt: { model: string; result: string; at: string; generation: number; configVersion: number } | null;
  appliedAt: string | null; lastUsedVersion: number | null;
};
