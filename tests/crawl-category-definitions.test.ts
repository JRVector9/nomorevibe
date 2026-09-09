import { expect, it } from 'vitest';
import { renderCategoryDefinitions } from '@/lib/crawl/classify';
import { mergeWithDefaults } from '@/lib/crawl/settings';
import {
  crawlSettingsSchema, categoryDefinitionsSchema, DEFAULT_CATEGORY_DEFINITIONS, DEFAULT_CRAWL_SETTINGS,
} from '@/lib/crawl/settings-schema';

/** 기준을 코드에서 데이터로 옮기기 전 프롬프트에 있던 문장 그대로 */
const PROMPT_BEFORE_THE_MOVE = [
  "Productivity: 개인·팀의 일정, 문서, 메모, 작업 및 워크플로 도구",
  "Dev: 코딩, API, SDK, 테스트, 인프라 및 개발자 도구",
  "Design: UI/UX, 그래픽, 3D 및 시각 디자인 도구",
  "Business: CRM, HR, 회사 운영, 프로젝트 운영 및 업무 협업",
  "Marketing: 광고, SEO, 영업 지원, 소셜 발행 및 고객 성장",
  "Finance: 투자, 은행, 회계, 결제 및 금융 분석",
  "Commerce: 쇼핑, 마켓플레이스, 소매, 주문 및 상품 탐색",
  "Education: 교육, 학습, 튜터링, 강의 및 학업",
  "Health: 신체·정신 건강, 웰니스 및 의료 지원",
  "Media: 영상, 오디오, 음악, 스토리 및 뉴스의 제작·편집·소비",
  "Games: 비디오게임, 게임 제작 도구 및 게임 커뮤니티",
  "Social: 메시징, 커뮤니티, 데이팅 및 소셜 네트워크",
  "Data: 분석, 데이터베이스, BI, 데이터 처리 및 시각화",
  "Security: 개인정보, 인증, 사이버보안 및 사기 방지",
  "Lifestyle: 여행, 음식, 집, 취미 및 개인 생활 서비스",
  "Sports: 운동, 스포츠 경기, 팀 운영 및 피트니스",
  "Other: 정보가 부족하거나 어느 분류에도 명확히 맞지 않음",
].join("\n");

it('기본값이면 프롬프트가 상수로 두었던 때와 한 글자도 다르지 않다', () => {
  expect(renderCategoryDefinitions(DEFAULT_CATEGORY_DEFINITIONS)).toBe(PROMPT_BEFORE_THE_MOVE);
});

it('포함·제외 예시는 해당 카테고리 줄 아래에만 붙는다', () => {
  const rendered = renderCategoryDefinitions({
    ...DEFAULT_CATEGORY_DEFINITIONS,
    Games: { summary: '실제로 플레이할 수 있는 것', include: ['웹 게임', '게임 수치 계산기'], exclude: ['게임 엔진 → Dev'] },
  });
  expect(rendered).toContain('Games: 실제로 플레이할 수 있는 것\n  포함: 웹 게임 / 게임 수치 계산기\n  제외: 게임 엔진 → Dev\n');
  // 손대지 않은 카테고리는 그대로다
  expect(rendered).toContain('Dev: 코딩, API, SDK, 테스트, 인프라 및 개발자 도구\nDesign:');
});

it('한 카테고리만 저장돼 있어도 나머지 16개는 기본값으로 채운다', () => {
  const merged = mergeWithDefaults({
    ...DEFAULT_CRAWL_SETTINGS,
    classify: { definitions: { Dev: { summary: '개발자가 직접 쓰는 도구', include: [], exclude: ['일반 자동화 → Productivity'] } } },
  });
  expect(merged.classify.definitions.Dev.exclude).toEqual(['일반 자동화 → Productivity']);
  expect(Object.keys(merged.classify.definitions)).toHaveLength(17);
  expect(merged.classify.definitions.Games).toEqual(DEFAULT_CATEGORY_DEFINITIONS.Games);
});

it('classify가 통째로 없는 옛 설정 행도 기본값으로 읽힌다', () => {
  const withoutClassify: Record<string, unknown> = { ...DEFAULT_CRAWL_SETTINGS };
  delete withoutClassify.classify;
  expect(mergeWithDefaults(withoutClassify).classify.definitions).toEqual(DEFAULT_CATEGORY_DEFINITIONS);
});

it('모르는 카테고리와 규격을 벗어난 값은 저장되지 않는다', () => {
  expect(categoryDefinitionsSchema.safeParse({ ...DEFAULT_CATEGORY_DEFINITIONS, Crypto: { summary: 'x', include: [], exclude: [] } }).success).toBe(false);
  expect(crawlSettingsSchema.safeParse({ ...DEFAULT_CRAWL_SETTINGS,
    classify: { definitions: { ...DEFAULT_CATEGORY_DEFINITIONS, Dev: { summary: '', include: [], exclude: [] } } } }).success).toBe(false);
  expect(crawlSettingsSchema.safeParse({ ...DEFAULT_CRAWL_SETTINGS,
    classify: { definitions: { ...DEFAULT_CATEGORY_DEFINITIONS, Dev: { summary: 'ok', include: Array(13).fill('x'), exclude: [] } } } }).success).toBe(false);
});
