import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { CONFIDENCE_FLOOR_SOURCES, detectImportSource, IMPORT_SOURCES, parseImportLine, QWEN_VISION_AUTO_SOURCE, QWEN_VISION_M1_SOURCE, QWEN_VISION_SHOT2_SOURCE, SCREEN_REVIEW_SOURCES,
  SCREENSHOT_SOURCES } from '@/lib/crawl/audit-import-sources';
import { importHoldEffect } from '@/lib/crawl/audit-import-gate';
import { countedOpinion } from '@/lib/crawl/product-audit-hold';
import { secondOpinionFamily, sameOpinionModel } from '@/lib/crawl/second-opinion-rules';
import { DEFAULT_AUDIT_HOLD } from '@/lib/crawl/settings-schema';

/** m1 화면 재판정 줄의 모양(2026-10-22 held-recheck/m1.jsonl) — 이름·주소는 지어낸 것 */
const vision = (over: Record<string, unknown> = {}) => JSON.stringify({ slug: 'acme', itemId: 33154, name: 'Acme', url: 'https://acme.test', before: 23, after: 5448,
  shot: true, ms: 59871, decision: 'approve', confidence: 0.95, reason: 'The page is a working web app …', ...over });
const grok = (over: Record<string, unknown> = {}) => JSON.stringify({ auditResultId: 7, productId: 3, grokDecision: 'reject', grokConfidence: 0.9,
  grokReason: 'a design agency site', model: 'grok-4-fast', inputHash: 'a'.repeat(64), error: null, ...over });

describe('두 번째 의견 파일의 줄 읽기', () => {
  it('m1 화면 재판정 줄 — 항목·slug·결정·확신·사유·스크린샷 여부를 읽고, 모델 이름은 출처의 것(+vision)', () => {
    expect(parseImportLine(QWEN_VISION_M1_SOURCE, vision())).toEqual({ itemId: 33154, productId: null, slug: 'acme', model: 'qwen3.8-flash-next+vision',
      decision: 'approve', confidence: 0.95, reason: 'The page is a working web app …', inputHash: null, shot: true });
    expect(parseImportLine(QWEN_VISION_M1_SOURCE, vision({ shot: false, decision: 'reject', confidence: 1 }))).toMatchObject({ shot: false, decision: 'reject' });
    expect(parseImportLine(QWEN_VISION_M1_SOURCE, JSON.stringify({ slug: 'x', itemId: 1, shot: true, ms: 1, error: 'qwen_invalid_json', detail: 'invalid_json' }))).toBe('error');
    for (const bad of [vision({ decision: 'maybe' }), vision({ confidence: 1.5 }), vision({ itemId: -1 }), vision({ slug: '' }), '{nope', '[]', vision({ reason: 'x'.repeat(20_000) })]) {
      expect(parseImportLine(QWEN_VISION_M1_SOURCE, bad)).toBe('invalid');
    }
    expect((parseImportLine(QWEN_VISION_M1_SOURCE, vision({ reason: 'r'.repeat(3_000) })) as { reason: string }).reason).toHaveLength(2_000);
  });

  it('grok 일괄 줄 — CLI 와 같은 칸, 모델은 줄의 것', () => {
    expect(parseImportLine('grok-cli-batch', grok())).toEqual({ itemId: 7, productId: 3, slug: null, model: 'grok-4-fast', decision: 'reject', confidence: 0.9,
      reason: 'a design agency site', inputHash: 'a'.repeat(64), shot: false });
    expect(parseImportLine('grok-cli-batch', grok({ error: 'timeout' }))).toBe('error');
    expect(parseImportLine('grok-cli-batch', grok({ productId: 'x' }))).toBe('invalid');
    // grok 모양의 줄을 화면 재판정으로 읽으면 맞지 않는다
    expect(parseImportLine(QWEN_VISION_M1_SOURCE, grok())).toBe('invalid');
  });

  it('출처를 알아맞힌다 — 앞의 줄 모양으로', () => {
    expect(detectImportSource([vision()])).toBe(QWEN_VISION_M1_SOURCE);
    expect(detectImportSource(['', 'nope', grok()])).toBe('grok-cli-batch');
    expect(detectImportSource(['{}'])).toBeNull();
  });

  it('화면 재판정 모델은 자동 의견과 다른 줄이지만 모델 갈래는 qwen 이다(카탈로그 예외가 그대로 걸린다)', () => {
    const model = IMPORT_SOURCES[QWEN_VISION_M1_SOURCE].model;
    expect(sameOpinionModel(model, 'qwen3.8-flash-next')).toBe(false);
    expect(secondOpinionFamily(model)).toBe('qwen');
    expect(SCREENSHOT_SOURCES.has(QWEN_VISION_M1_SOURCE)).toBe(true);
    expect(SCREENSHOT_SOURCES.has('grok-cli-batch')).toBe(false);
    // 운영 화면 판정(qwen-vision-auto)도 같은 확신 하한(0.90)으로 센다
    expect(CONFIDENCE_FLOOR_SOURCES).toEqual({ [QWEN_VISION_M1_SOURCE]: 0.9, [QWEN_VISION_AUTO_SOURCE]: 0.9, [QWEN_VISION_SHOT2_SOURCE]: 0.9 });
  });

  it('화면 판정 출처 — 스크린샷까지 본 올리기 출처와 운영 화면 판정. 글만 본 출처(grok 일괄·m1 자동 의견)는 아니다', () => {
    expect([...SCREEN_REVIEW_SOURCES].sort()).toEqual([QWEN_VISION_AUTO_SOURCE, QWEN_VISION_M1_SOURCE, QWEN_VISION_SHOT2_SOURCE]);
    expect(SCREEN_REVIEW_SOURCES.has('grok-cli-batch')).toBe(false);
    expect(SCREEN_REVIEW_SOURCES.has('qwen-v2-auto')).toBe(false);
  });
});

describe('보류에서 세는가·올린 의견이 보류에 무엇을 하나', () => {
  const model = IMPORT_SOURCES[QWEN_VISION_M1_SOURCE].model;
  const m1 = (decision: 'approve' | 'reject', confidence: number) => ({ model, decision, source: QWEN_VISION_M1_SOURCE, confidence });
  const grokReject = { model: 'grok-4-fast', decision: 'reject', source: 'grok-cli-batch', confidence: 0.9 };
  const EMPTY = 'The page text is empty; only shows a title and a JavaScript bundle';
  const effect = (opinions: { model: string; decision: string; source: string; confidence: number }[], supersede: boolean, line = opinions.at(-1)!) =>
    importHoldEffect({ item: { reason: EMPTY, model: '[MLX] gpt-oss-120b', confidence: 0.97 }, opinions,
      line: { decision: line.decision, confidence: line.confidence, shot: true, source: line.source, model: line.model }, hold: DEFAULT_AUDIT_HOLD,
      options: { autoOpinions: false }, supersede });

  it('m1 의견은 확신 0.90 이상일 때만 센다 — 승인·거절 모두. grok 은 늘 센다', () => {
    expect(countedOpinion(m1('approve', 0.9), {})).toBe(true);
    expect(countedOpinion(m1('approve', 0.85), {})).toBe(false);
    expect(countedOpinion(m1('reject', 0.85), {})).toBe(false);
    expect(countedOpinion(grokReject, {})).toBe(true);
  });

  it('남은 거절이 없으면 승인이 보류를 푼다(gate) — 남은 글만 본 거절이 있으면 대체를 켰을 때만(supersede), 무엇을 대신했는지 남긴다', () => {
    expect(effect([m1('approve', 0.95)], false)).toEqual({ release: 'gate', superseded: [], blockers: [] });
    expect(effect([grokReject, m1('approve', 0.95)], false)).toEqual({ release: null, superseded: [],
      blockers: [{ kind: 'reject', model: 'grok-4-fast', source: 'grok-cli-batch', confidence: 0.9 }] });
    expect(effect([grokReject, m1('approve', 0.95)], true)).toEqual({ release: 'supersede',
      superseded: [{ model: 'grok-4-fast', source: 'grok-cli-batch', confidence: 0.9 }], blockers: [] });
  });

  it('대체는 하한 아래 승인·스크린샷 없는 줄로는 하지 않고, 사유 갈래 보류도 막는 것으로 보인다', () => {
    expect(effect([grokReject, m1('approve', 0.85)], true)).toMatchObject({ release: null,
      blockers: [{ kind: 'reject', model: 'grok-4-fast' }, { kind: 'category', category: 'placeholder' }] });
    const noShot = importHoldEffect({ item: { reason: EMPTY, model: '[MLX] gpt-oss-120b', confidence: 0.97 }, opinions: [grokReject, m1('approve', 0.95)],
      line: { decision: 'approve', confidence: 0.95, shot: false, source: QWEN_VISION_M1_SOURCE, model }, hold: DEFAULT_AUDIT_HOLD, options: {}, supersede: true });
    expect(noShot.release).toBeNull();
  });
});
