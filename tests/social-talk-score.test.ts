import { expect, it } from 'vitest';
import { BLUESKY_TALK_POINTS, postScore, repositoryTalkScore, TALK_THRESHOLD, talkQualifies, type TalkPostInput } from '@/lib/social/talk-score';

const NOW = new Date('2026-10-18T06:00:00Z');
const hn = (points: number, comments: number, postedAt: string, kind: 'link' | 'show' = 'link'): TalkPostInput =>
  ({ source: 'hn', kind, points, comments, postedAt: new Date(postedAt) });

it('HN 은 30점 또는 댓글 15개를 넘어야 화면에 오른다', () => {
  expect(talkQualifies(hn(30, 0, '2026-10-18T00:00:00Z'))).toBe(true);
  expect(talkQualifies(hn(12, 15, '2026-10-18T00:00:00Z'))).toBe(true);
  expect(talkQualifies(hn(29, 14, '2026-10-18T00:00:00Z'))).toBe(false);
  expect(talkQualifies({ source: 'geeknews', kind: 'show', points: 3, comments: 0, postedAt: NOW })).toBe(true);
  expect(talkQualifies({ source: 'geeknews', kind: 'link', points: 4, comments: 9, postedAt: NOW })).toBe(false);
});

it('글 점수는 점수와 댓글 절반의 로그다', () => {
  expect(postScore(hn(230, 80, '2026-10-12T00:48:00Z'))).toBeCloseTo(Math.log2(271));
});

it('지금은 36시간마다 절반 — 실측 10/18 15시 KST 기준 Konnect 가 Doory 보다 앞선다', () => {
  // Doory HN 230점·댓글 80 (10/12 09:48 KST), Konnect HN 143점·댓글 52 (10/14 19:51 KST)
  const doory = [hn(230, 80, '2026-10-12T00:48:00Z')];
  const konnect = [hn(143, 52, '2026-10-14T10:51:00Z')];
  expect(repositoryTalkScore(konnect, NOW, 'now')!).toBeGreaterThan(repositoryTalkScore(doory, NOW, 'now')!);
  // 이번 주는 반감 없이 — 큰 글이 앞선다
  expect(repositoryTalkScore(doory, NOW, 'week')!).toBeGreaterThan(repositoryTalkScore(konnect, NOW, 'week')!);
});

it('출처마다 가장 큰 글 하나만 세고, 출처가 둘이면 1을 더한다', () => {
  const posts = [hn(100, 0, '2026-10-18T00:00:00Z'), hn(40, 0, '2026-10-18T00:00:00Z')];
  expect(repositoryTalkScore(posts, NOW, 'week')).toBeCloseTo(Math.log2(101));
  const withGn = [...posts, { source: 'geeknews' as const, kind: 'link' as const, points: 7, comments: 2, postedAt: new Date('2026-10-18T00:00:00Z') }];
  expect(repositoryTalkScore(withGn, NOW, 'week')).toBeCloseTo(Math.log2(101) + 1.6 * Math.log2(9) + 1);
});

it('Bluesky 는 반응(좋아요 + 재게시×2) 5 부터 오르고, 출처마다 가장 큰 글 하나만 센다', () => {
  const bsky = (points: number): TalkPostInput => ({ source: 'bluesky', kind: 'link', points, comments: 0, postedAt: new Date('2026-10-18T00:00:00Z') });
  expect(TALK_THRESHOLD.bluesky.points).toBe(BLUESKY_TALK_POINTS);
  expect(BLUESKY_TALK_POINTS).toBe(5);
  expect(talkQualifies(bsky(5))).toBe(true);
  expect(talkQualifies(bsky(4))).toBe(false);
  // Bluesky 5·9 와 HN 40 — Bluesky 는 9 하나만, 출처가 둘이라 1을 더한다
  const posts = [bsky(5), bsky(9), hn(40, 0, '2026-10-18T00:00:00Z')];
  expect(repositoryTalkScore(posts, NOW, 'week')).toBeCloseTo(Math.log2(41) + Math.log2(10) + 1);
});

it('자격 글이 없거나 7일이 지난 글뿐이면 화제가 아니다', () => {
  expect(repositoryTalkScore([hn(12, 3, '2026-10-18T00:00:00Z')], NOW, 'now')).toBeNull();
  expect(repositoryTalkScore([hn(300, 90, '2026-10-10T00:00:00Z')], NOW, 'week')).toBeNull();
  expect(repositoryTalkScore([], NOW, 'week')).toBeNull();
});
