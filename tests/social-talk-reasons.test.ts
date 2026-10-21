import { describe, expect, it, vi } from 'vitest';
import type { TalkGroup, TalkPost } from '@/lib/social/talk';
import type { TalkProductCheck, TalkVerdictPost } from '@/lib/social/talk-reasons';

vi.mock('server-only', () => ({}));
const { shownPostIds, talkPlacement, talkVerdict, thresholdLabel } = await import('@/lib/social/talk-reasons');
const { TALK_LIST_LIMIT } = await import('@/lib/social/talk');

const NOW = new Date('2026-10-20T06:00:00Z');
const HOUR = 3_600_000;
const publicProduct: TalkProductCheck = { slug: 'acme-app', status: 'seeded', publicProduct: true, down: false, unlisted: false, auditHeld: false, repoGone: false };
const post = (extra: Partial<TalkVerdictPost> = {}): TalkVerdictPost => ({
  id: 1, source: 'hn', kind: 'link', state: 'visible', linkTarget: 'repo', repositoryKey: 'acme/app',
  postedAt: new Date(NOW.getTime() - 10 * HOUR), lastSeenAt: new Date(NOW.getTime() - HOUR), points: 40, comments: 3,
  excluded: false, product: publicProduct, ...extra,
});
const talkPost = (id: number): TalkPost => ({
  id, source: 'hn', externalId: String(id), kind: 'link', title: 't', linkTarget: 'repo', postedAt: NOW, points: 40, comments: 0, frontPage: false,
});
const group = (key: string, ids: number[], score: number | null): TalkGroup => ({
  repositoryKey: key, score, posts: ids.map(talkPost), product: { id: ids[0] } as TalkGroup['product'],
});
const labels = (value: ReturnType<typeof talkVerdict>) => value.reasons.map(reason => reason.label);

describe('/talk 자리', () => {
  it('점수 있는 저장소만 1부터 순위를 달고, 한 화면 안의 글만 보이는 글로 센다', () => {
    const groups = [
      ...Array.from({ length: TALK_LIST_LIMIT + 1 }, (_, index) => group(`acme/r${index}`, [100 + index], 100 - index)),
      group('acme/quiet', [9], null),
    ];
    const placement = talkPlacement(groups);
    expect(placement.get(100)).toEqual({ rank: 1 });
    expect(placement.get(100 + TALK_LIST_LIMIT)).toEqual({ rank: TALK_LIST_LIMIT + 1 });
    expect(placement.get(9)).toEqual({ rank: null });
    expect(shownPostIds(placement)).toHaveLength(TALK_LIST_LIMIT);
    expect(shownPostIds(placement)).not.toContain(100 + TALK_LIST_LIMIT);
  });
});

describe('왜 /talk 에 없나', () => {
  it('후보에 든 글은 순위로 — 보임, 순위 밖, 자격 글 없음, 같은 저장소 다른 글 덕', () => {
    const placement = talkPlacement([group('acme/app', [1, 2], 5), group('acme/quiet', [3], null)]);
    expect(talkVerdict(post(), placement, NOW)).toEqual({ shown: true, rank: 1, reasons: [] });
    expect(labels(talkVerdict(post({ id: 2, points: 3 }), placement, NOW))).toEqual(['같은 저장소의 다른 글로 오름']);
    expect(talkVerdict(post({ id: 3, points: 12 }), placement, NOW)).toEqual({
      shown: false, rank: null, reasons: [{ code: 'below', label: `점수 미달 — ${thresholdLabel('hn')} 아래` }],
    });
    const far = new Map([[4, { rank: TALK_LIST_LIMIT + 3 }]]);
    expect(talkVerdict(post({ id: 4 }), far, NOW)).toMatchObject({ shown: false, rank: TALK_LIST_LIMIT + 3, reasons: [{ code: 'rank_out' }] });
  });

  it('후보에 없는 글은 막힌 조건을 모두 적는다', () => {
    const none = new Map();
    expect(labels(talkVerdict(post({ state: 'gone' }), none, NOW))).toEqual(['원문 삭제']);
    expect(labels(talkVerdict(post({ state: 'hidden', postedAt: new Date(NOW.getTime() - 8 * 24 * HOUR) }), none, NOW))).toEqual(['숨김', '7일 지남']);
    expect(labels(talkVerdict(post({ excluded: true }), none, NOW))).toEqual(['저장소 빼기']);
    expect(labels(talkVerdict(post({ linkTarget: 'issue' }), none, NOW))).toEqual(['이슈·PR 글 — 제품 상세에만']);
    expect(labels(talkVerdict(post({ product: null, points: 5 }), none, NOW))).toEqual(['공개 제품 아님 — 제품 없음', `점수 미달 — ${thresholdLabel('hn')} 아래`]);
    expect(labels(talkVerdict(post({ product: { ...publicProduct, status: 'banned', publicProduct: false } }), none, NOW))).toEqual(['공개 제품 아님 — banned']);
    expect(labels(talkVerdict(post({ product: { ...publicProduct, publicProduct: false, down: true, auditHeld: true } }), none, NOW)))
      .toEqual(['공개 제품 아님 — 응답 없음·감사 보류']);
    expect(labels(talkVerdict(post({ postedAt: new Date(NOW.getTime() + HOUR) }), none, NOW))).toEqual(['게시 시각이 지금보다 뒤']);
  });

  it('저장소 키 없는 글(HN 의 github.io·X 의 제품 사이트)은 저장소 아님으로 적고 제품을 찾지 않는다', () => {
    const none = new Map();
    expect(labels(talkVerdict(post({ linkTarget: 'site', repositoryKey: null, product: null }), none, NOW))).toEqual(['저장소 아님 — 저장소 모양이 아닌 주소']);
    expect(labels(talkVerdict(post({ source: 'x', linkTarget: 'site', repositoryKey: null, product: null, points: 80 }), none, NOW)))
      .toEqual(['저장소 아님 — 저장소 모양이 아닌 주소']);
  });

  it('X 는 마지막 확인 뒤 24시간이 지나면, 반응이 기준 아래면 적는다', () => {
    const none = new Map();
    expect(labels(talkVerdict(post({ source: 'x', points: 80, lastSeenAt: new Date(NOW.getTime() - 25 * HOUR) }), none, NOW))).toEqual(['X 확인 24시간 지남']);
    expect(labels(talkVerdict(post({ source: 'x', points: 20, state: 'hidden' }), none, NOW))).toEqual(['숨김', `점수 미달 — ${thresholdLabel('x')} 아래`]);
    expect(thresholdLabel('x')).toBe('X 반응 50');
    expect(thresholdLabel('hn')).toBe('HN 30점 또는 댓글 15개');
  });

  it('Bluesky — 수집기가 숨긴 까닭(봇·라벨)·저장소 여럿·확인 24시간·반응 5 기준을 적는다', () => {
    const none = new Map();
    const bsky = (extra: Partial<TalkVerdictPost> = {}) => post({ source: 'bluesky', points: 12, ...extra });
    expect(talkVerdict(bsky({ state: 'hidden', stateReason: 'bot_suspected' }), none, NOW).reasons)
      .toEqual([{ code: 'bot', label: '숨김 — 봇으로 보임(72시간에 GitHub 링크 글 15개 이상)' }]);
    expect(labels(talkVerdict(bsky({ state: 'hidden', stateReason: 'label:bot' }), none, NOW))).toEqual(['숨김 — 봇 계정(스스로 자동 계정이라 밝힘)']);
    expect(labels(talkVerdict(bsky({ state: 'hidden', stateReason: 'label:!no-unauthenticated' }), none, NOW))).toEqual(['숨김 — 로그아웃 사용자에게 보이지 않기를 원한 계정']);
    expect(talkVerdict(bsky({ state: 'hidden', stateReason: 'label:porn' }), none, NOW).reasons).toEqual([{ code: 'label', label: '숨김 — 라벨 porn' }]);
    expect(labels(talkVerdict(bsky({ state: 'hidden', stateReason: 'admin' }), none, NOW))).toEqual(['숨김']);
    // 저장소 주소인데 키가 없다 — 저장소 여럿을 가리킨 글
    expect(talkVerdict(bsky({ linkTarget: 'site', repositoryKey: null, product: null, linkUrl: 'https://github.com/acme/one' }), none, NOW).reasons)
      .toEqual([{ code: 'multi_repo', label: '저장소 여럿 — 공개 제품 저장소가 없어 어느 한 곳에도 세지 않음' }]);
    expect(labels(talkVerdict(bsky({ linkTarget: 'site', repositoryKey: null, product: null, linkUrl: 'https://github.com/sponsors/acme' }), none, NOW)))
      .toEqual(['저장소 아님 — 저장소 모양이 아닌 주소']);
    expect(talkVerdict(bsky({ lastSeenAt: new Date(NOW.getTime() - 25 * HOUR) }), none, NOW).reasons)
      .toEqual([{ code: 'bluesky_stale', label: 'Bluesky 확인 24시간 지남' }]);
    expect(labels(talkVerdict(bsky({ points: 4 }), none, NOW))).toEqual(['점수 미달 — Bluesky 반응 5 아래']);
    expect(thresholdLabel('bluesky')).toBe('Bluesky 반응 5');
  });

  it('조건을 모두 넘었는데 후보에 없으면 모른다고 적는다', () => {
    expect(talkVerdict(post(), new Map(), NOW)).toMatchObject({ shown: false, reasons: [{ code: 'unknown' }] });
  });
});
