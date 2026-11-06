import 'server-only';

import { aiTask } from '@/lib/llm/ai-tasks';
import { REVIEW_PROMPT_VERSION } from '@/lib/crawl/agent-review-contract';
import { REVIEW_SYSTEM_PROMPT, reviewCliPrompt } from '@/lib/crawl/agent-review';
import { GATEWAY_SYSTEM_SUFFIX } from '@/lib/crawl/agent-review-gateway';
import { OPENCODE_REVIEW_AGENT, opencodeReviewConfig } from '@/lib/crawl/agent-review-opencode';
import { grokReviewAgentDefinition } from '@/lib/crawl/agent-review-grok';
import { DEEPSEEK_REVIEW_SYSTEM_PROMPT } from '@/lib/crawl/deepseek-review';
import { QWEN_V2_ADDENDUM, QWEN_V2_PROMPT_VERSION, qwenPromptConfig } from '@/lib/crawl/qwen-direct-review';
import { crawlTaglineGatewayWire, type TaglineEvidence } from '@/lib/crawl/tagline';
import { promptFor, type ClassifyInput } from '@/lib/crawl/classify';
import { profileGatewayWire, type ProfileEvidence } from '@/lib/domain/products/search-profile';
import { searchVerifyGatewayWire } from '@/lib/domain/products/search-verify';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '@/lib/domain/products/embedding';
import {
  productTaglineKoGatewayWire,
  productTaglineKoLegacyWire,
  productTranslationGatewayWire,
  reasonTranslationGatewayWire,
} from '@/lib/crawl/translate';
import { QWEN_TRANSLATION_PROMPT_VERSION } from '@/lib/crawl/translation-prompts';
import { KOREAN_QWEN_RUNTIME_PROMPT_VERSION } from '@/lib/crawl/korean-translation-prompts';
import { introCheckCliArgs } from '@/lib/domain/products/intro-check';
import type { FlowPromptResponse, FlowPromptSection, FlowPromptStage } from './flow-prompts-contract';
import { flowModelStage } from './flow-model-catalog';

const SECTION_ERROR = '이 템플릿을 읽지 못했습니다';
const RESPONSE_NOTE = '현재 코드의 템플릿입니다. {{...}}는 동적 입력이며 실제 후보·사용자 자료를 조회하지 않습니다. 모델·전송 방식에 따른 변형은 각 설명을 확인하세요.';

// reviewCliPrompt가 <, >를 이스케이프합니다. 실제 ReviewInput은 읽지 않는 JSON 형식 설명입니다.
const REVIEW_USER_TEMPLATE = reviewCliPrompt('{{JSON.stringify(ReviewInput.snapshot)}}');

const INTRO_USER_TEMPLATE = `<untrusted_evidence_json>
{{JSON.stringify(IntroItem[]); evidence escaped}}
</untrusted_evidence_json>`;

const REVIEW_VARIABLES = [
  'snapshot.product.repo',
  'snapshot.product.name',
  'snapshot.product.description',
  'snapshot.product.pageText',
  'snapshot.product.url',
  'snapshot.product.topics',
  'snapshot.product.language',
  'snapshot.product.accessMode',
  'snapshot.product.repositoryUrl',
  'snapshot.product.readme',
  'snapshot.product.linksOwnGithub',
  'snapshot.product.packageProof',
  'snapshot.repoFacts.stars',
  'snapshot.repoFacts.pushedAt',
  'snapshot.repoFacts.createdAt',
  'snapshot.rules.stoppedAt',
  'snapshot.rules.detail',
  'snapshot.rules.cause',
  'snapshot.policy.rulesVersion',
  'snapshot.policy.promptVersion',
  'snapshot.policy.detectorVersion',
  'snapshot.policy.policyVersion',
  'snapshot.policy.enforceEligibility',
  'snapshot.evidence[].id',
  'snapshot.evidence[].observation',
  'snapshot.evidenceSummary',
  'snapshot.relationship',
  'snapshot.scanState',
  'snapshot.evidenceTruncated',
];

const PROFILE_VARIABLES = [
  'name',
  'url',
  'category',
  'topics',
  'tagline',
  'description',
  'pageText',
  'readme',
  'reviewerNote',
  'evidenceLevel',
];

const PLACEHOLDER_TAGLINE_EVIDENCE: TaglineEvidence = {
  name: '{{name}}',
  url: '{{url}}',
  topics: ['{{topics}}'],
  language: '{{language}}',
  pageTitle: '{{pageTitle}}',
  pageText: '{{pageText}}',
  readme: '{{readme}}',
};

const PLACEHOLDER_PROFILE_EVIDENCE: ProfileEvidence = {
  name: '{{name}}',
  url: '{{url}}',
  category: '{{category}}',
  topics: '{{topics}}',
  tagline: '{{tagline}}',
  description: '{{description}}',
  pageText: '{{pageText}}',
  readme: '{{readme}}',
  reviewerNote: '{{reviewerNote}}',
  evidenceLevel: 'thin',
};

const PLACEHOLDER_CLASSIFY_INPUT: ClassifyInput = {
  repo: '{{repo}}',
  url: '{{url}}',
  name: '{{name}}',
  tagline: '{{tagline}}',
  topics: ['{{topics}}'],
  language: '{{language}}',
  readme: '{{readme}}',
};

type SectionBody = Omit<FlowPromptSection, 'id' | 'title' | 'source' | 'error'>;

function failedSection(id: string, title: string, source: string[], notes: string[]): FlowPromptSection {
  return { id, title, source, system: null, userTemplate: null, variables: [], notes, error: SECTION_ERROR };
}

function safeSection(id: string, title: string, source: string[], fallbackNotes: string[], build: () => SectionBody): FlowPromptSection {
  try {
    return { id, title, source, ...build() };
  } catch {
    return failedSection(id, title, source, fallbackNotes);
  }
}

async function safeAsyncSection(
  id: string,
  title: string,
  source: string[],
  fallbackNotes: string[],
  build: () => Promise<SectionBody>,
): Promise<FlowPromptSection> {
  try {
    const body = await build();
    return { id, title, source, ...body };
  } catch {
    return failedSection(id, title, source, fallbackNotes);
  }
}

function messagesFromWire(wire: string): { system: string | null; userTemplate: string | null } {
  const parsed = JSON.parse(wire) as { messages?: unknown };
  const messages = Array.isArray(parsed.messages)
    ? parsed.messages as { role?: unknown; content?: unknown }[]
    : [];
  const find = (role: string): string | null => {
    const message = messages.find((item) => item && item.role === role && typeof item.content === 'string');
    return typeof message?.content === 'string' ? message.content : null;
  };
  return { system: find('system'), userTemplate: find('user') };
}

function opencodePrompt(): string {
  const config = JSON.parse(opencodeReviewConfig()) as { agent?: Record<string, { prompt?: unknown }> };
  const prompt = config.agent?.[OPENCODE_REVIEW_AGENT]?.prompt;
  if (typeof prompt !== 'string') throw new Error('opencode_prompt_missing');
  return prompt;
}

function cliArgValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function reviewSections(stage: 'first' | 'second'): FlowPromptSection[] {
  const title = stage === 'first' ? '1차 심사' : '2차 심사';
  const inactive = '이 변형이 현재 활성이라는 뜻은 아닙니다.';
  return [
    safeSection(`${stage}-claude-cli`, `${title} — Claude CLI`, ['lib/crawl/agent-review.ts'], [inactive], () => ({
      system: REVIEW_SYSTEM_PROMPT,
      userTemplate: REVIEW_USER_TEMPLATE,
      variables: REVIEW_VARIABLES,
      notes: [
        'variant: claude-cli (reviewWithAgent)',
        '공유 REVIEW_SYSTEM_PROMPT와 REVIEW_PROMPT_VERSION을 그대로 사용합니다.',
        '사용자 입력은 실제 ReviewInput이 아니라 JSON.stringify(snapshot) 형식 설명입니다.',
        inactive,
      ],
      version: REVIEW_PROMPT_VERSION,
    })),
    safeSection(`${stage}-gateway`, `${title} — direct API (local-direct) shared wire`, ['lib/crawl/agent-review.ts', 'lib/crawl/agent-review-gateway.ts'], [inactive], () => ({
      system: `${REVIEW_SYSTEM_PROMPT}${GATEWAY_SYSTEM_SUFFIX}`,
      userTemplate: REVIEW_USER_TEMPLATE,
      variables: REVIEW_VARIABLES,
      notes: [
        'variant: direct API (local-direct) shared wire',
        'AI1·AI2가 같은 REVIEW_SYSTEM_PROMPT와 GATEWAY_SYSTEM_SUFFIX를 쓰는 shared direct wire입니다.',
        '사용자 입력은 실제 ReviewInput이 아니라 JSON.stringify(snapshot) 형식 설명입니다.',
        inactive,
      ],
      version: REVIEW_PROMPT_VERSION,
    })),
    safeSection(`${stage}-opencode-cli`, `${title} — OpenCode CLI`, ['lib/crawl/agent-review.ts', 'lib/crawl/agent-review-opencode.ts'], [inactive], () => ({
      system: opencodePrompt(),
      userTemplate: REVIEW_USER_TEMPLATE,
      variables: REVIEW_VARIABLES,
      notes: [
        'variant: opencode-cli',
        'JSON.parse(opencodeReviewConfig()).agent[OPENCODE_REVIEW_AGENT].prompt만 사용합니다. 전체 config/env는 반환하지 않습니다.',
        '사용자 입력은 실제 ReviewInput이 아니라 JSON.stringify(snapshot) 형식 설명입니다.',
        inactive,
      ],
      version: REVIEW_PROMPT_VERSION,
    })),
    safeSection(`${stage}-grok-cli`, `${title} — Grok CLI`, ['lib/crawl/agent-review.ts', 'lib/crawl/agent-review-grok.ts'], [inactive], () => ({
      system: grokReviewAgentDefinition(),
      userTemplate: REVIEW_USER_TEMPLATE,
      variables: REVIEW_VARIABLES,
      notes: [
        'variant: grok-cli',
        'grokReviewAgentDefinition() 전체입니다. frontmatter는 에이전트 파일 메타데이터이고, 구분선 뒤가 시스템 프롬프트입니다.',
        '사용자 입력은 실제 ReviewInput이 아니라 JSON.stringify(snapshot) 형식 설명입니다.',
        inactive,
      ],
      version: REVIEW_PROMPT_VERSION,
    })),
  ];
}

function taskLabel(id: string): string {
  return aiTask(id)?.label ?? id;
}

function humanSections(): FlowPromptSection[] {
  const qwen = qwenPromptConfig();
  const qwenVersion = qwen?.version ?? QWEN_V2_PROMPT_VERSION;
  const qwenSystem = `${REVIEW_SYSTEM_PROMPT}${qwen?.addendum ?? QWEN_V2_ADDENDUM}`;
  const adapter = '모델 이름과 무관한 단계 어댑터입니다. 선택 엔진이 바뀔 수 있습니다.';
  const humanReviewLabel = taskLabel('human-review');
  const splitConfirmLabel = taskLabel('split-confirm');
  const heldReviewRetryLabel = taskLabel('held-review-retry');
  const splitTiebreakLabel = taskLabel('split-tiebreak');
  const qwenNotes = [
    adapter,
    'REVIEW_SYSTEM_PROMPT + QWEN_V2_ADDENDUM(기본 qwenPromptConfig v2)입니다.',
    'v3 평가용 덧붙임은 현재 활성 기본값이 아닙니다.',
    '사용자 입력은 실제 ReviewInput이 아니라 JSON.stringify(snapshot) 형식 설명입니다.',
  ];
  return [
    safeSection('human-deepseek', `사람 검토 — ${humanReviewLabel} / ${splitConfirmLabel}`, ['lib/crawl/agent-review.ts', 'lib/crawl/deepseek-review.ts'], [adapter], () => ({
      system: DEEPSEEK_REVIEW_SYSTEM_PROMPT,
      userTemplate: REVIEW_USER_TEMPLATE,
      variables: REVIEW_VARIABLES,
      notes: [
        adapter,
        'human-review와 split-confirm 확인이 같은 DeepSeek 정책을 사용합니다.',
        'REVIEW_SYSTEM_PROMPT 뒤에 고정 문장을 붙인 실제 상수입니다.',
        '사용자 입력은 실제 ReviewInput이 아니라 JSON.stringify(snapshot) 형식 설명입니다.',
      ],
      version: REVIEW_PROMPT_VERSION,
    })),
    safeSection('human-held-review-retry', `사람 검토 — ${heldReviewRetryLabel}`, ['lib/crawl/agent-review.ts', 'lib/crawl/qwen-direct-review.ts'], [adapter], () => ({
      system: qwenSystem,
      userTemplate: REVIEW_USER_TEMPLATE,
      variables: REVIEW_VARIABLES,
      notes: qwenNotes,
      version: qwenVersion,
    })),
    safeSection('human-split-tiebreak', `사람 검토 — ${splitTiebreakLabel}`, ['lib/crawl/agent-review.ts', 'lib/crawl/qwen-direct-review.ts'], [adapter], () => ({
      system: qwenSystem,
      userTemplate: REVIEW_USER_TEMPLATE,
      variables: REVIEW_VARIABLES,
      notes: qwenNotes,
      version: qwenVersion,
    })),
  ];
}

function profileSection(): FlowPromptSection {
  const reuse = 'crawlTaglineGatewayWire를 직접 재사용합니다.';
  return safeSection('profile-tagline', '프로필 — 한 줄 소개 작성', ['lib/crawl/tagline.ts'], [reuse], () => {
    const messages = messagesFromWire(crawlTaglineGatewayWire(PLACEHOLDER_TAGLINE_EVIDENCE, '{{model}}'));
    return {
      system: messages.system,
      userTemplate: messages.userTemplate,
      variables: ['name', 'url', 'topics', 'language', 'pageTitle', 'pageText', 'readme'],
      notes: [
        reuse,
        'wire에서 messages의 role=system/user content 문자열만 반환합니다.',
        'model, max_tokens 등 전송 필드와 키는 반환하지 않습니다.',
        '모든 값은 {{field}} 형식의 입력 형식 설명이며 실제 레코드가 아닙니다.',
      ],
    };
  });
}

async function readCrawlSettingsRow(): Promise<{ values?: unknown } | null> {
  const [{ db, onPrimary }, { crawlSettings }, { eq, sql }] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema'),
    import('drizzle-orm'),
  ]);
  return onPrimary(() => db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
    const rows = await tx.select({ values: crawlSettings.values }).from(crawlSettings).where(eq(crawlSettings.id, 1)).limit(1);
    return rows[0] ?? null;
  }, { accessMode: 'read only' }));
}

async function publishSection(): Promise<FlowPromptSection> {
  const fallback = '현재 분류 정의를 읽지 못했습니다.';
  return safeAsyncSection('publish-classify', '발행 — 분류 결합 프롬프트 (CLI / direct API)', ['lib/crawl/classify.ts', 'lib/crawl/settings.ts', 'lib/crawl/settings-schema.ts', 'lib/crawl/publication-classify-gateway.ts'], [fallback], async () => {
    const { mergeWithDefaults, settingsUnreadable } = await import('@/lib/crawl/settings');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const row = await Promise.race([
        readCrawlSettingsRow(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('settings_timeout')), 3000);
        }),
      ]);
      const settings = mergeWithDefaults(row?.values);
      const state = !row
        ? '저장된 crawl_settings id=1 행이 없어 런타임 기본값을 사용합니다.'
        : settingsUnreadable(settings)
          ? '저장된 crawl_settings id=1 행을 해석하지 못해 런타임 기본값을 사용합니다.'
          : '저장된 crawl_settings id=1 행의 현재 분류 정의를 사용합니다.';
      return {
        system: null,
        userTemplate: promptFor([PLACEHOLDER_CLASSIFY_INPUT], settings.classify.definitions),
        variables: ['repo', 'url', 'name', 'tagline', 'topics', 'language', 'readme'],
        notes: [
          state,
          'CLI 결합 프롬프트는 정책 + 분류 정의 + JSON을 합친 promptFor(...) 결과를 사용하며 system은 null입니다.',
          'direct API(local-direct)도 같은 promptFor(...) 결과를 messages의 user content로 보내며 system 메시지는 없습니다.',
          '한 항목 대표 템플릿입니다. 실제 런타임 배치 길이는 달라질 수 있습니다.',
          '저장된 다른 설정, 키, 실제 제품 행은 반환하지 않습니다.',
        ],
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}

function keywordSections(): FlowPromptSection[] {
  return [
    safeSection('keywords-profile', '키워드 — 검색 프로필', ['lib/domain/products/search-profile.ts'], ['profileGatewayWire를 직접 재사용합니다.'], () => {
      const messages = messagesFromWire(profileGatewayWire(PLACEHOLDER_PROFILE_EVIDENCE, '{{model}}'));
      return {
        system: messages.system,
        userTemplate: messages.userTemplate,
        variables: PROFILE_VARIABLES,
        notes: [
          'profileGatewayWire를 직접 재사용합니다.',
          'wire에서 messages의 role=system/user content 문자열만 반환합니다.',
          'evidenceLevel은 실제 런타임에 thin 또는 rich입니다. 예시 값은 thin입니다.',
          '모든 값은 {{field}} 형식의 입력 형식 설명이며 실제 레코드가 아닙니다.',
        ],
      };
    }),
    safeSection('keywords-verify', '키워드 — 검수', ['lib/domain/products/search-verify.ts'], ['searchVerifyGatewayWire를 직접 재사용합니다.'], () => {
      const messages = messagesFromWire(searchVerifyGatewayWire({ evidence: PLACEHOLDER_PROFILE_EVIDENCE, keywords: ['{{keyword}}'] }, '{{model}}'));
      return {
        system: messages.system,
        userTemplate: messages.userTemplate,
        variables: [...PROFILE_VARIABLES, 'keywords[]'],
        notes: [
          'searchVerifyGatewayWire를 직접 재사용합니다.',
          'wire에서 messages의 role=system/user content 문자열만 반환합니다.',
          '키워드 한 개를 보인 대표 템플릿입니다. 실제 실행은 5개 단위 청크입니다.',
          'evidenceLevel은 실제 런타임에 thin 또는 rich입니다. 예시 값은 thin입니다.',
          '모든 값은 {{field}} 형식의 입력 형식 설명이며 실제 레코드가 아닙니다.',
        ],
      };
    }),
    safeSection('keywords-embedding', '키워드 — BGE 제품 임베딩 (생성형 프롬프트 없음)', ['lib/domain/products/embedding.ts'], ['임베딩 메타데이터를 읽지 못했습니다.'], () => ({
      system: null,
      userTemplate: '{{text[]}}',
      variables: ['text[]'],
      notes: [
        `embedding.ts의 EMBEDDING_MODEL=${EMBEDDING_MODEL}, EMBEDDING_DIMENSIONS=${EMBEDDING_DIMENSIONS}입니다.`,
        'embedTexts 입력은 문자열 배열입니다. 제품 문서와 원시 검색 질의가 같은 벡터 공간을 사용합니다.',
        '생성형 시스템 프롬프트는 없습니다.',
      ],
      version: `${EMBEDDING_MODEL} (${EMBEDDING_DIMENSIONS}d)`,
    })),
  ];
}

function supportSections(): FlowPromptSection[] {
  const branch = `'qwen'과 'generic'은 템플릿 분기 선택자이며 실제 등록 모델 이름을 주장하지 않습니다.`;
  const taglineItems = [{ name: '{{name}}', tagline: '{{tagline}}' }];
  const productItems = [{ name: '{{name}}', locale: 'en' as const, field: 'tagline' as const, text: '{{원문}}' }];
  return [
    safeSection('support-reason-translation', '지원 — 심사 사유 번역', ['lib/crawl/translate.ts'], ['reasonTranslationGatewayWire를 직접 재사용합니다.'], () => {
      const messages = messagesFromWire(reasonTranslationGatewayWire(['{{검수사유}}'], '{{model}}'));
      return {
        system: messages.system,
        userTemplate: messages.userTemplate,
        variables: ['검수사유'],
        notes: [
          'reasonTranslationGatewayWire를 직접 재사용합니다.',
          'wire에서 messages의 role=system/user content 문자열만 반환합니다.',
          '모델과 배치 수는 런타임에 달라질 수 있습니다.',
        ],
      };
    }),
    safeSection('support-tagline-ko-qwen', '지원 — 한국어 소개 (qwen 분기)', ['lib/crawl/translate.ts', 'lib/crawl/translation-prompts.ts'], [branch], () => {
      const messages = messagesFromWire(productTaglineKoGatewayWire(taglineItems, 'qwen'));
      return {
        system: messages.system,
        userTemplate: messages.userTemplate,
        variables: ['name', 'tagline'],
        notes: [branch, '한 항목 대표 템플릿입니다. 실제 배치 수는 런타임에 달라집니다.', 'wire에서 messages만 반환합니다.'],
        version: QWEN_TRANSLATION_PROMPT_VERSION,
      };
    }),
    safeSection('support-tagline-ko-generic', '지원 — 한국어 소개 (generic 분기)', ['lib/crawl/translate.ts'], [branch], () => {
      const messages = messagesFromWire(productTaglineKoGatewayWire(taglineItems, 'generic'));
      return {
        system: messages.system,
        userTemplate: messages.userTemplate,
        variables: ['name', 'tagline'],
        notes: [branch, '비Qwen generic 분기입니다. 한 항목 대표 템플릿이며 실제 배치 수는 런타임에 달라집니다.', 'wire에서 messages만 반환합니다.'],
      };
    }),
    safeSection('support-tagline-ko-legacy-qwen', '지원 — 한국어 소개 legacy (qwen 분기)', ['lib/crawl/translate.ts', 'lib/crawl/korean-translation-prompts.ts'], [branch], () => {
      const messages = messagesFromWire(productTaglineKoLegacyWire(taglineItems, 'qwen'));
      return {
        system: messages.system,
        userTemplate: messages.userTemplate,
        variables: ['name', 'tagline'],
        notes: [branch, 'productTaglineKoLegacyWire의 확장 legacy 조건입니다.', '한 항목 대표 템플릿이며 실제 배치 수는 런타임에 달라집니다.', 'wire에서 messages만 반환합니다.'],
        version: KOREAN_QWEN_RUNTIME_PROMPT_VERSION,
      };
    }),
    safeSection('support-product-translation-qwen', '지원 — 제품 번역 (qwen 분기)', ['lib/crawl/translate.ts', 'lib/crawl/translation-prompts.ts'], [branch], () => {
      const messages = messagesFromWire(productTranslationGatewayWire(productItems, 'qwen'));
      return {
        system: messages.system,
        userTemplate: messages.userTemplate,
        variables: ['name', 'locale', 'field', 'text'],
        notes: [branch, 'locale=en, field=tagline 대표값입니다. 실제 locale/field는 런타임에 달라질 수 있습니다.', '제품 번역은 보호 토큰이 추가된 입력을 사용합니다.', 'wire에서 messages만 반환합니다.'],
        version: QWEN_TRANSLATION_PROMPT_VERSION,
      };
    }),
    safeSection('support-product-translation-generic', '지원 — 제품 번역 (generic 분기)', ['lib/crawl/translate.ts'], [branch], () => {
      const messages = messagesFromWire(productTranslationGatewayWire(productItems, 'generic'));
      return {
        system: messages.system,
        userTemplate: messages.userTemplate,
        variables: ['name', 'locale', 'field', 'text'],
        notes: [branch, '비Qwen generic 분기입니다. locale=en, field=tagline 대표값이며 실제 locale/field는 런타임에 달라질 수 있습니다.', 'wire에서 messages만 반환합니다.'],
      };
    }),
    safeSection('support-intro-check', '지원 — 소개 검수 CLI', ['lib/domain/products/intro-check.ts'], ['introCheckCliArgs를 읽지 못했습니다.'], () => {
      const args = introCheckCliArgs('{{model}}');
      const system = cliArgValue(args, '--system-prompt');
      if (!system) throw new Error('intro_system_missing');
      return {
        system,
        userTemplate: INTRO_USER_TEMPLATE,
        variables: [
          'items[].slug',
          'items[].intro',
          'items[].evidence.name',
          'items[].evidence.url',
          'items[].evidence.topics',
          'items[].evidence.description',
          'items[].evidence.pageText',
          'items[].evidence.readme',
        ],
        notes: [
          `introCheckCliArgs('{{model}}')의 --system-prompt 다음 값을 읽었습니다. CLI는 실행하지 않습니다.`,
          '사용자 입력은 IntroItem[] JSON 형식 설명입니다.',
          '모델과 배치 수는 런타임에 달라질 수 있습니다.',
        ],
      };
    }),
  ];
}

export async function readFlowPrompts(stage: FlowPromptStage): Promise<FlowPromptResponse> {
  const observedAt = new Date().toISOString();
  const sections = stage === 'first' || stage === 'second'
    ? reviewSections(stage)
    : stage === 'human'
      ? humanSections()
      : stage === 'profile'
        ? [profileSection()]
        : stage === 'publish'
          ? [await publishSection()]
          : stage === 'keywords'
            ? keywordSections()
            : supportSections();
  return { stage, label: flowModelStage(stage)?.label ?? stage, observedAt, sections, note: RESPONSE_NOTE };
}
