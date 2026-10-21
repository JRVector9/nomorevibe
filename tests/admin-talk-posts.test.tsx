import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { discussionUrl } from '@/components/social/talk-format';
import type { TalkPostRow } from '@/app/(operator)/admin/talk/TalkPostsBoard';

vi.mock('@/app/(operator)/admin/talk/actions', () => ({ decideTalkPosts: vi.fn(), excludeTalkRepository: vi.fn() }));
const { TalkPostsBoard } = await import('@/app/(operator)/admin/talk/TalkPostsBoard');

const NOW = '2026-10-20T06:00:00.000Z';
const row = (extra: Partial<TalkPostRow>): TalkPostRow => ({
  id: 1, source: 'Hacker News', kind: 'link', title: 'Doory', discussionUrl: discussionUrl({ source: 'hn', externalId: '45001' }),
  linkUrl: 'https://github.com/acme/app', linkHost: 'github.com', linkTarget: 'repo', repositoryKey: 'acme/app', points: 90, comments: 20,
  frontPage: false, postedAt: '2026-10-19T12:00:00.000Z', firstSeenAt: '2026-10-19T12:30:00.000Z', lastSeenAt: '2026-10-20T05:30:00.000Z',
  state: 'visible', excluded: false, product: { slug: 'acme-app', status: 'seeded' }, talk: { shown: true, rank: 2, reasons: [] }, ...extra,
});

it('수집한 글마다 원문·가리킨 주소·연결 제품·확인 시각과 /talk 판정을 보인다', () => {
  const html = renderToStaticMarkup(<TalkPostsBoard now={NOW} rows={[
    row({}),
    row({
      id: 2, source: 'X', title: 'X 게시물 1900000000000000001', discussionUrl: discussionUrl({ source: 'x', externalId: '1900000000000000001' }),
      linkUrl: 'https://acme.example/', linkHost: 'acme.example', linkTarget: 'site', repositoryKey: null, product: null,
      talk: { shown: false, rank: null, reasons: ['저장소 아님 — 저장소 모양이 아닌 주소', 'X 확인 24시간 지남'] },
    }),
    row({ id: 3, state: 'hidden', linkUrl: null, linkHost: 'weird', talk: { shown: false, rank: null, reasons: ['숨김'] } }),
  ]} />);
  expect(html).toContain('href="https://news.ycombinator.com/item?id=45001"');
  expect(html).toContain('href="https://x.com/i/web/status/1900000000000000001"');
  expect(html).toContain('href="https://acme.example/"');
  expect(html).toContain('href="/p/acme-app"');
  expect(html).toContain('보임 · 2위');
  expect(html).toContain('저장소 아님 — 저장소 모양이 아닌 주소');
  expect(html).toContain('X 확인 24시간 지남');
  expect(html).toContain('저장소 없음');
  expect(html).toContain('처음 ');
  expect(html).toContain('마지막 ');
  // 저장소 없는 글에는 저장소 빼기 단추가 없다 — 키가 있는 두 줄만
  expect(html.match(/저장소를 화제에서 빼기/g)).toHaveLength(2);
  // http(s) 가 아닌 주소는 링크를 달지 않는다
  expect(html).not.toContain('href="weird"');
});

it('Bluesky 글은 원문 게시물 링크와 숨긴 까닭(봇·라벨)을 보인다', () => {
  const id = 'did:plc:ltjj43huonogytm4szn5hzkx/3mygbhpmh762y';
  const html = renderToStaticMarkup(<TalkPostsBoard now={NOW} rows={[
    row({ id: 4, source: 'Bluesky', title: 'Bluesky 게시물 3mygbhpmh762y', discussionUrl: discussionUrl({ source: 'bluesky', externalId: id }),
      state: 'hidden', talk: { shown: false, rank: null, reasons: ['숨김 — 봇으로 보임(72시간에 GitHub 링크 글 15개 이상)'] } }),
  ]} />);
  expect(html).toContain('href="https://bsky.app/profile/did:plc:ltjj43huonogytm4szn5hzkx/post/3mygbhpmh762y"');
  expect(html).toContain('Bluesky 게시물 3mygbhpmh762y');
  expect(html).toContain('숨김 — 봇으로 보임');
});

it('조건에 맞는 글이 없으면 그렇게 적는다', () => {
  expect(renderToStaticMarkup(<TalkPostsBoard now={NOW} rows={[]} />)).toContain('조건에 맞는 글이 없습니다.');
});
