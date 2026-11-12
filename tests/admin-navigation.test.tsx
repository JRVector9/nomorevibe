import { readdirSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdminNav, auditBadge, countBadge, NAV_GROUPS, workspaceBadge } from '@/app/(operator)/admin/AdminNav';
import { WorkspaceTabs } from '@/app/(operator)/admin/components/WorkspaceTabs';
import { STATUS_TABS } from '@/app/(operator)/admin/status/action-links';
import {
  MODELS_ADVANCED_EDITORS, resolveWorkspace, secondaryIsActive, WORKSPACE_GROUPS, WORKSPACE_LEGACY_SCREENS, WORKSPACE_SECONDARY, WORKSPACES,
  type WorkspaceId,
} from '@/app/(operator)/admin/workspace-navigation';

const query = (raw = '') => new URLSearchParams(raw);
const split = (url: string) => { const [pathname, search = ''] = url.split('?'); return { pathname, search }; };
const resolve = (url: string) => { const { pathname, search } = split(url); return resolveWorkspace(pathname, query(search)); };
const activeLinks = (html: string) => (html.match(/<a\b[^>]*>/g) ?? []).filter(tag => tag.includes('aria-current="page"'));
const expectActiveLink = (html: string, href: string) => expect(activeLinks(html)).toEqual(expect.arrayContaining([expect.stringContaining(`href="${href.replaceAll('&', '&amp;')}"`)]));

/**
 * 주소 → 메뉴·탭·2차 메뉴 항목. 2026-11-12 메뉴 여섯(조각 1a)의 기준표다 — 아래 「빠짐없이」 검사가
 * 옛 메뉴(작업 공간 7개·탭 28개·고급 편집기 8개·2차 메뉴)의 모든 주소와 관리자 화면 전부가 이 표에 있는지 본다.
 */
const ADDRESSES: readonly (readonly [url: string, menu: WorkspaceId, tab: string, secondaryTab: string | null])[] = [
  // 홈 — 운영 홈(할 일 + 흐름, 단계 패널 ?stage=)과 흐름 상세(옛 ?tab=flow 포함)·시스템 진단·할 일·변경 기록, 오늘 할 일, 운영센터의 나머지 탭
  ['/admin/flow', 'home', 'home', null],
  ['/admin/flow?tab=home', 'home', 'home', null],
  ['/admin/flow?stage=first', 'home', 'home', null],
  ['/admin/flow?tab=detail', 'home', 'detail', null],
  ['/admin/flow?tab=detail&stage=first', 'home', 'detail', null],
  ['/admin/flow?tab=flow', 'home', 'detail', null],
  ['/admin/flow?tab=diagnostics', 'home', 'diagnostics', null],
  ['/admin/flow?tab=changes', 'home', 'changes', null],
  ['/admin/flow?tab=unknown', 'home', 'home', null],
  // 홈 › 알림(조각 4b) — 휴대폰 알림 켜기·끄기와 조용한 시간
  ['/admin/alerts', 'home', 'alerts', null],
  ['/admin/inbox', 'home', 'changes', 'inbox'],
  ['/admin/activity?workspace=home&group=settings', 'home', 'changes', 'changes'],
  ['/admin/activity?workspace=home', 'home', 'changes', 'changes'],
  ['/admin/status', 'home', 'diagnostics', null],
  ['/admin/status?tab=overview', 'home', 'diagnostics', null],
  ['/admin/status?tab=ai', 'home', 'diagnostics', null],
  ['/admin/status?tab=diagnostics', 'home', 'diagnostics', null],
  ['/admin/status?tab=flow', 'home', 'diagnostics', null],
  // 사람 확인 › 묶음(기본 화면, 조각 3b)
  ['/admin/review/batches', 'people', 'batches', null],
  // 사람 확인 › 검수 및 발행
  ['/admin/review', 'people', 'review', 'human'],
  ['/admin/review?tab=human', 'people', 'review', 'human'],
  ['/admin/review?tab=all', 'people', 'review', 'all'],
  ['/admin/review?tab=publish&stage=publish', 'people', 'review', 'publish'],
  ['/admin/review?tab=rejected&stage=rejected', 'people', 'review', 'rejected'],
  ['/admin/review?stage=human', 'people', 'review', 'human'],
  ['/admin/review?stage=agreed', 'people', 'review', 'human'],
  ['/admin/review?stage=publish', 'people', 'review', 'publish'],
  ['/admin/review?state=approved', 'people', 'review', 'publish'],
  ['/admin/review?stage=rejected', 'people', 'review', 'rejected'],
  ['/admin/review?stage=first', 'people', 'review', 'all'],
  ['/admin/status?tab=manual', 'people', 'review', 'publish'],
  // 사람 확인 › 요청함
  ['/admin/requests', 'people', 'requests', 'open'],
  ['/admin/requests?tab=open', 'people', 'requests', 'open'],
  ['/admin/requests?tab=correction', 'people', 'requests', 'correction'],
  ['/admin/requests?tab=contact', 'people', 'requests', 'contact'],
  ['/admin/requests?tab=posts', 'people', 'requests', 'posts'],
  ['/admin/requests?tab=posts&kind=feedback', 'people', 'requests', 'posts'],
  ['/admin/requests?tab=registration', 'people', 'requests', 'registration'],
  ['/admin/requests?tab=history', 'people', 'requests', 'history'],
  ['/admin/requests?state=all', 'people', 'requests', 'contact'],
  ['/admin/requests?offset=20', 'people', 'requests', 'contact'],
  ['/admin/requests?state=&offset=', 'people', 'requests', 'contact'],
  ['/admin/requests?tab=posts&state=held', 'people', 'requests', 'posts'],
  ['/admin/requests?tab=open&offset=20', 'people', 'requests', 'open'],
  ['/admin/requests?tab=unknown&state=all', 'people', 'requests', 'open'],
  ['/admin/requests?tab=&offset=20', 'people', 'requests', 'open'],
  ['/admin/requests?tab=constructor', 'people', 'requests', 'open'],
  ['/admin/audit?tab=requests', 'people', 'requests', 'correction'],
  ['/admin/feedback', 'people', 'requests', 'feedback'],
  ['/admin/feedback?state=held', 'people', 'requests', 'feedback'],
  ['/admin/maker-replies', 'people', 'requests', 'replies'],
  ['/admin/reactions', 'people', 'requests', 'reactions'],
  // 사람 확인 › 품질관리 · 사람 위임 모델
  ['/admin/products?tab=quality', 'people', 'quality', null],
  ['/admin/products?tab=quality&mode=second', 'people', 'quality', null],
  ['/admin/audit', 'people', 'quality', 'audit'],
  ['/admin/audit?tab=audit', 'people', 'quality', 'audit'],
  ['/admin/audit?tab=policy', 'people', 'quality', 'audit'],
  ['/admin/audit?tab=audit&view=held', 'people', 'quality', 'audit'],
  ['/admin/review?second=published', 'people', 'quality', 'published'],
  ['/admin/products/recheck', 'people', 'quality', 'recheck'],
  ['/admin/models/human', 'people', 'delegate', null],
  // 모델
  // 운영 콘솔 조각 3a: /admin/models 는 모델 목록(?model= 상세), 옛 대시보드·LLM 운영은 고급 설정의 2차 메뉴
  ['/admin/models', 'models', 'list', null],
  ['/admin/models?model=conn-supa-direct', 'models', 'list', null],
  ['/admin/models/new', 'models', 'list', null],
  ['/admin/models/new?id=00000000-0000-4000-8000-000000000000&step=2', 'models', 'list', null],
  ['/admin/models/compare', 'models', 'list', null],
  ['/admin/models/compare?task=product-tagline-ko', 'models', 'list', null],
  ['/admin/models?tab=live', 'models', 'advanced', 'dashboard'],
  ['/admin/models?tab=unknown', 'models', 'list', null],
  ['/admin/models?tab=constructor', 'models', 'list', null],
  ['/admin/models?tab=tasks', 'models', 'tasks', null],
  ['/admin/models?tab=connections', 'models', 'advanced', 'llm'],
  ['/admin/models?tab=capacity', 'models', 'advanced', 'llm'],
  ['/admin/models/dashboard', 'models', 'advanced', 'dashboard'],
  ['/admin/models/llm', 'models', 'advanced', 'llm'],
  ['/admin/models/tasks', 'models', 'tasks', null],
  ['/admin/models/advanced', 'models', 'advanced', 'overview'],
  ['/admin/models?advanced=1', 'models', 'advanced', null],
  ['/admin/models?tab=live&advanced=1', 'models', 'advanced', null],
  ['/admin/models/limits', 'models', 'advanced', 'limits'],
  ['/admin/models/devices', 'models', 'advanced', 'devices'],
  ['/admin/models/allocation', 'models', 'advanced', 'allocation'],
  ['/admin/models/helpers', 'models', 'advanced', 'helpers'],
  ['/admin/models/assignments', 'models', 'advanced', 'assignments'],
  ['/admin/models/contracts', 'models', 'advanced', 'contracts'],
  ['/admin/models/search', 'models', 'advanced', 'search'],
  // 수집·작업
  // 운영 콘솔 조각 4a: 기본은 수집원·주기 작업(?source= 상세, ?job= 줄의 조치), 수집원 추가 세 걸음
  ['/admin/sources', 'sources', 'sources', null],
  ['/admin/sources?source=show-hn', 'sources', 'sources', null],
  ['/admin/sources/new', 'sources', 'sources', null],
  ['/admin/sources/new?kind=feed', 'sources', 'sources', null],
  ['/admin', 'sources', 'collection', null],
  ['/admin/settings', 'sources', 'collection', null],
  ['/admin/settings?tab=collection', 'sources', 'collection', null],
  ['/admin/settings?tab=evidence', 'sources', 'evidence', null],
  ['/admin/settings?tab=integrations', 'sources', 'integrations', null],
  ['/admin/settings?tab=jobs', 'sources', 'collection', null],
  ['/admin/status?tab=jobs', 'sources', 'jobs', null],
  ['/admin/status?tab=jobs&job=crawl-fetch', 'sources', 'jobs', null],
  ['/admin/status?tab=crawlers', 'sources', 'crawlers', null],
  ['/admin/categories', 'sources', 'evidence', 'categories'],
  ['/admin/evidence', 'sources', 'evidence', 'evidence'],
  ['/admin/github-accounts', 'sources', 'integrations', 'accounts'],
  ['/admin/github-integrations', 'sources', 'integrations', 'deliveries'],
  // 콘텐츠
  ['/admin/products', 'content', 'products', null],
  ['/admin/products?tab=unknown', 'content', 'products', null],
  ['/admin/products?filter=%EC%9D%91%EB%8B%B5%20%EC%97%86%EC%9D%8C', 'content', 'products', null],
  ['/admin/products?tab=translations', 'content', 'translations', null],
  ['/admin/products/example', 'content', 'products', null],
  ['/admin/translations', 'content', 'translations', null],
  ['/admin/content', 'content', 'social', null],
  ['/admin/content?tab=social', 'content', 'social', null],
  ['/admin/content?tab=news', 'content', 'news', null],
  ['/admin/content?tab=ranking', 'content', 'ranking', null],
  ['/admin/content?tab=unknown', 'content', 'social', null],
  ['/admin/content?tab=products', 'content', 'social', null],
  ['/admin/talk', 'content', 'social', null],
  ['/admin/news', 'content', 'news', null],
  ['/admin/ranking', 'content', 'ranking', null],
  // 기록 — 기본은 바꾼 것 한 줄씩(조각 4b), 원시 줄은 모두 보기(작업 로그)
  ['/admin/log', 'log', 'summary', null],
  ['/admin/log?q=supa', 'log', 'summary', null],
  ['/admin/activity?q=supa', 'log', 'changes', null],
  ['/admin/settings?tab=history', 'log', 'history', null],
  ['/admin/activity', 'log', 'changes', null],
  ['/admin/activity?group=takedown', 'log', 'changes', null],
  ['/admin/activity?target=example', 'log', 'changes', null],
  ['/admin/activity?workspace=models&group=llm', 'log', 'changes', null],
  ['/admin/activity?workspace=projects', 'log', 'changes', null],
  ['/admin/models/history', 'log', 'llm', null],
  ['/admin/models?tab=history', 'log', 'llm', null],
];

/** origin/main 41f365a4 의 옛 메뉴 — 작업 공간 7개의 주소와 탭 28개 */
const OLD_WORKSPACE_HREFS = [
  '/admin/flow', '/admin/flow?tab=diagnostics', '/admin/flow?tab=changes',
  '/admin/review', '/admin/review?tab=human', '/admin/review?tab=all', '/admin/review?tab=publish&stage=publish', '/admin/review?tab=rejected&stage=rejected',
  '/admin/requests', '/admin/requests?tab=open', '/admin/requests?tab=correction', '/admin/requests?tab=contact', '/admin/requests?tab=posts',
  '/admin/requests?tab=registration', '/admin/requests?tab=history',
  '/admin/products', '/admin/products?tab=quality', '/admin/products?tab=translations',
  '/admin/models', '/admin/models/llm', '/admin/models/tasks', '/admin/models/history', '/admin/models/advanced',
  '/admin/content', '/admin/content?tab=social', '/admin/content?tab=news', '/admin/content?tab=ranking',
  '/admin/settings', '/admin/settings?tab=collection', '/admin/settings?tab=evidence', '/admin/settings?tab=integrations', '/admin/settings?tab=history',
];
/** origin/main 41f365a4 의 옛 2차 메뉴 주소 */
const OLD_SECONDARY_HREFS = [
  '/admin/inbox', '/admin/activity?workspace=home&group=settings',
  '/admin/models/advanced', ...MODELS_ADVANCED_EDITORS.map(editor => editor.href),
  '/admin/audit?tab=audit', '/admin/review?second=published', '/admin/products/recheck',
  '/admin/feedback', '/admin/maker-replies', '/admin/reactions',
  '/admin/categories', '/admin/evidence', '/admin/github-accounts', '/admin/github-integrations',
];
/** 관리자 화면(page.tsx) 전부 — 새 화면이 생기면 메뉴 자리를 정하고 이 표에 더해야 한다 */
function adminPages(dir = path.resolve(__dirname, '../app/(operator)/admin'), route = '/admin'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? adminPages(path.join(dir, entry.name), `${route}/${entry.name === '[slug]' ? 'example' : entry.name}`)
    : entry.name === 'page.tsx' ? [route] : []);
}

describe('메뉴 여섯', () => {
  it('시안의 이름 그대로 여섯 메뉴를 그린다', () => {
    expect(WORKSPACES.map(page => page.label)).toEqual(['홈', '사람 확인', '모델', '수집·작업', '콘텐츠', '기록']);
    expect(WORKSPACE_GROUPS.flatMap(group => group.pages).map(page => page.id)).toEqual(WORKSPACES.map(page => page.id));
    const html = renderToStaticMarkup(<AdminNav current="/admin/flow" />);
    expect(html.match(/href="\/admin/g)).toHaveLength(6);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).not.toContain('<small>');
    expectActiveLink(html, '/admin/flow');
    for (const page of WORKSPACES) expect(html).toContain(`<span>${page.label}</span>`);
  });

  it('홈 탭은 운영 홈(기본)·흐름 상세·시스템 진단·할 일·변경 기록·알림이고, 오늘 할 일은 그 2차 메뉴에 둔다', () => {
    expect(WORKSPACES[0].tabs.map(tab => [tab.label, tab.href])).toEqual([['운영 홈', '/admin/flow'], ['흐름 상세', '/admin/flow?tab=detail'],
      ['시스템 진단', '/admin/flow?tab=diagnostics'], ['할 일·변경 기록', '/admin/flow?tab=changes'], ['알림', '/admin/alerts']]);
    expect(WORKSPACE_SECONDARY.homeChanges.map(link => link.href)).toEqual(['/admin/inbox', '/admin/activity?workspace=home&group=settings']);
  });

  it('사람 확인은 옛 작업 공간을 탭으로, 옛 탭을 2차 메뉴로 묶는다', () => {
    const people = WORKSPACES.find(page => page.id === 'people')!;
    expect(people.tabs.map(tab => tab.label)).toEqual(['묶음', '검수 및 발행', '요청함', '품질관리', '사람 위임 모델']);
    // 메뉴를 누르면 묶음 화면이 열리고, 옛 목록(검수 및 발행)은 하나씩 보기로 그대로 남는다
    expect(people.href).toBe('/admin/review/batches');
    expect(people.tabs.find(tab => tab.id === 'review')!.href).toBe('/admin/review');
    expect(WORKSPACE_SECONDARY.review.map(link => link.label)).toEqual(['사람 확인', '전체 단계', '발행 대기', '반려 기록']);
    expect(WORKSPACE_SECONDARY.requests.map(link => link.label)).toEqual(['처리 필요', '내림·수정', '문의', '글 검수', '등록·인증 현황', '처리 기록']);
    expect(WORKSPACE_SECONDARY.quality.map(link => link.label)).toEqual(['AI 감사·정책', '공개분 2차 확인', '규칙 재검수']);
  });

  it('모델은 목록이 기본이고, 고급 설정 2차 메뉴는 옛 대시보드·LLM 운영과 사람 위임 모델을 뺀 편집기 일곱 개다', () => {
    expect(WORKSPACES.find(page => page.id === 'models')!.tabs.map(tab => tab.label)).toEqual(['모델 목록', '작업 배정', '고급 설정']);
    expect(WORKSPACES.find(page => page.id === 'models')!.href).toBe('/admin/models');
    expect(WORKSPACE_SECONDARY.modelsAdvanced.map(link => link.label)).toEqual(['고급 설정', '대시보드', 'LLM 운영', '실시간 한도', '장비 한도', '칸 배분', '도우미·감시자',
      '모델 배정 표', '서빙 계약·등록부', '검색 모델']);
  });
});

describe('기록 메뉴(조각 4b)', () => {
  it('기본은 바꾼 것 한 줄씩이고 원시 작업 로그는 「모두 보기」로 남는다', () => {
    const log = WORKSPACES.find(page => page.id === 'log')!;
    expect(log.href).toBe('/admin/log');
    expect(log.tabs.map(tab => [tab.label, tab.href])).toEqual([['바꾼 것', '/admin/log'], ['모두 보기', '/admin/activity'],
      ['운영 기록', '/admin/settings?tab=history'], ['LLM 기록', '/admin/models/history']]);
  });
});

describe('주소 → 메뉴 해석', () => {
  it.each(ADDRESSES)('%s 는 %s 메뉴의 %s 탭(2차 %s)', (url, owner, tab, secondaryTab) => {
    const location = resolve(url);
    expect(location.workspace.id).toBe(owner);
    expect(location.tab).toBe(tab);
    expect(location.secondaryTab).toBe(secondaryTab);
    // 켜진 탭과 2차 항목은 늘 그 메뉴 안의 것이다
    expect(location.workspace.tabs.map(item => item.id)).toContain(tab);
    if (secondaryTab !== null) expect(location.secondary.map(link => link.id)).toContain(secondaryTab);
    const { pathname, search } = split(url);
    const nav = renderToStaticMarkup(<AdminNav current={pathname} search={search} />);
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    expectActiveLink(nav, location.workspace.href);
    const tabs = renderToStaticMarkup(<WorkspaceTabs location={location} />);
    expect(activeLinks(tabs)).toHaveLength(secondaryTab === null ? 1 : 2);
    expectActiveLink(tabs, location.workspace.tabs.find(item => item.id === tab)!.href);
    if (secondaryTab !== null) expectActiveLink(tabs, location.secondary.find(link => link.id === secondaryTab)!.href);
  });

  it('옛 메뉴의 주소(탭 28개·작업 공간 7개·고급 편집기 8개·2차 메뉴)가 빠짐없이 표에 있다', () => {
    const known = new Set(ADDRESSES.map(([url]) => url));
    expect(OLD_WORKSPACE_HREFS).toHaveLength(32);
    expect(MODELS_ADVANCED_EDITORS).toHaveLength(8);
    for (const url of [...OLD_WORKSPACE_HREFS, ...OLD_SECONDARY_HREFS]) expect(known, url).toContain(url);
  });

  it('새 메뉴·탭·2차 메뉴의 주소, 옛 화면 목록, 운영센터 탭, 관리자 화면 전부가 표에 있다', () => {
    const known = new Set(ADDRESSES.map(([url]) => url));
    const urls = [
      ...WORKSPACES.flatMap(page => [page.href, ...page.tabs.map(tab => tab.href)]),
      ...Object.values(WORKSPACE_SECONDARY).flatMap(links => links.map(link => link.href)),
      ...NAV_GROUPS.flatMap(group => group.pages.map(page => page.href)),
      ...WORKSPACE_LEGACY_SCREENS.filter(url => url !== '/admin/login').map(url => url.replace('[slug]', 'example')),
      ...STATUS_TABS.map(tab => `/admin/status?tab=${tab}`),
      ...adminPages().filter(url => url !== '/admin/login'),
    ];
    expect(adminPages()).toEqual(expect.arrayContaining(['/admin', '/admin/flow', '/admin/models/human', '/admin/products/example']));
    for (const url of urls) expect(known, url).toContain(url);
  });

  it('메뉴·탭·2차 메뉴 링크는 누르면 바로 그 메뉴·탭·항목이 켜진다', () => {
    for (const page of WORKSPACES) {
      expect(resolve(page.href).workspace.id, page.href).toBe(page.id);
      for (const tab of page.tabs) {
        const location = resolve(tab.href);
        expect([location.workspace.id, location.tab], tab.href).toEqual([page.id, tab.id]);
      }
    }
    for (const links of Object.values(WORKSPACE_SECONDARY)) for (const link of links) {
      const location = resolve(link.href);
      expect(location.secondary, link.href).toBe(links);
      expect(location.secondaryTab, link.href).toBe(link.id);
    }
  });

  it('제품 상세만 상세 표시를 받는다', () => {
    expect(resolveWorkspace('/admin/products/example').detail).toBe('product');
    expect(resolveWorkspace('/admin/products/recheck').detail).toBeNull();
    expect(resolveWorkspace('/admin/models').detail).toBeNull();
  });
});

describe('탭과 2차 메뉴', () => {
  it('고급 설정 탭을 켜고 편집기 일곱 개를 모두 잇는다', () => {
    const html = renderToStaticMarkup(<WorkspaceTabs location={resolveWorkspace('/admin/models/helpers')} />);
    for (const href of ['/admin/models/advanced', '/admin/models/devices', '/admin/models/allocation', '/admin/models/limits', '/admin/models/helpers', '/admin/models/assignments',
      '/admin/models/contracts', '/admin/models/search']) expect(html).toContain(`href="${href}"`);
    expect(html).not.toContain('href="/admin/models/human"');
    expectActiveLink(html, '/admin/models/advanced');
    expectActiveLink(html, '/admin/models/helpers');
    for (const label of ['모델 목록', '작업 배정', '고급 설정', '대시보드', 'LLM 운영']) expect(html).toContain(`>${label}</a>`);
  });

  it('공개분 2차 확인, 감사 정책, 규칙 재검수를 품질관리 아래 나란히 둔다', () => {
    const html = renderToStaticMarkup(<WorkspaceTabs location={resolve('/admin/review?second=published')} />);
    expect(html).toContain('/admin/audit?tab=audit');
    expect(html).toContain('/admin/products/recheck');
    expectActiveLink(html, '/admin/products?tab=quality');
    expectActiveLink(html, '/admin/review?second=published');
    expect(html).toContain('aria-label="품질관리 상세 기능"');
  });

  it('검수 큐의 옛 stage 주소도 2차 메뉴의 제 항목을 켠다', () => {
    const html = renderToStaticMarkup(<WorkspaceTabs location={resolve('/admin/review?stage=agreed')} />);
    expectActiveLink(html, '/admin/review');
    expectActiveLink(html, '/admin/review?tab=human');
    expect(html).toContain('aria-label="검수 및 발행 상세 기능"');
  });

  it('matches query values instead of treating every audit URL as the same detail', () => {
    const item = { id: 'requests', label: '내림·수정', href: '/admin/audit?tab=requests' };
    expect(secondaryIsActive(item, '/admin/audit', query('tab=requests'))).toBe(true);
    expect(secondaryIsActive(item, '/admin/audit', query('tab=audit'))).toBe(false);
  });

  it('keeps audit policy inside the AI audit secondary tab', () => {
    const link = { id: 'audit', label: 'AI 감사·정책', href: '/admin/audit?tab=audit' };
    expect(secondaryIsActive(link, '/admin/audit', query('tab=policy'))).toBe(true);
    expect(secondaryIsActive(link, '/admin/audit', query())).toBe(true);
    expect(secondaryIsActive(link, '/admin/audit', query('tab=requests'))).toBe(false);
  });

  it('오늘 할 일과 변경 기록을 홈에서 따로 연다', () => {
    const html = renderToStaticMarkup(<WorkspaceTabs location={resolveWorkspace('/admin/inbox')} />);
    expect(html).toContain('href="/admin/inbox"');
    expect(html).toContain('href="/admin/activity?workspace=home&amp;group=settings"');
    expectActiveLink(html, '/admin/inbox');
    expectActiveLink(html, '/admin/flow?tab=changes');
  });

  it.each(['/admin/flow?tab=diagnostics', '/admin/settings?tab=evidence', '/admin/settings?tab=integrations', '/admin/products?tab=quality', '/admin/models/human'])(
    '%s 는 화면이 스스로 하위 탭을 그리거나 하위가 없어 2차 메뉴를 두지 않는다', url => {
      const location = resolve(url);
      expect(location.secondary).toEqual([]);
      expect(renderToStaticMarkup(<WorkspaceTabs location={location} />)).not.toContain('admin-workspace-secondary');
    });

  it.each(['/admin/feedback', '/admin/maker-replies', '/admin/reactions'])('preserves every legacy post review link on %s', pathname => {
    const html = renderToStaticMarkup(<WorkspaceTabs location={resolveWorkspace(pathname)} />);
    for (const href of ['/admin/feedback', '/admin/maker-replies', '/admin/reactions']) expect(html).toContain(`href="${href}"`);
    expectActiveLink(html, pathname);
    expectActiveLink(html, '/admin/requests');
  });

  it.each([
    ['/admin/categories', '/admin/evidence'],
    ['/admin/evidence', '/admin/categories'],
    ['/admin/github-accounts', '/admin/github-integrations'],
    ['/admin/github-integrations', '/admin/github-accounts'],
  ])('keeps sibling settings screens reachable on legacy %s', (pathname, sibling) => {
    const html = renderToStaticMarkup(<WorkspaceTabs location={resolveWorkspace(pathname)} />);
    expect(html).toContain('admin-workspace-secondary');
    expect(html).toContain(`href="${sibling}"`);
    expectActiveLink(html, pathname);
  });
});

describe('메뉴 배지', () => {
  it('하나뿐이면 그 수와 낭독 글자를 그대로 둔다', () => {
    const badge = countBadge(1234, 'warn', n => `직접 판단 ${n}건`);
    expect(countBadge(0, 'warn')).toBeUndefined();
    expect(countBadge(null, 'critical')).toBeUndefined();
    expect(workspaceBadge('people', { '/admin/review': badge })).toEqual(badge);
    const html = renderToStaticMarkup(<AdminNav current="/admin/flow" badges={{ '/admin/review': badge }} />);
    expect(html).toContain('<span class="admin-vh">직접 판단 1,234건</span>');
    expect(html).toMatch(/href="\/admin\/review\/batches"[^]*?data-tone="warn"[^>]*>/);
  });

  it('홈에는 운영센터의 긴급 수를 붙인다', () => {
    const html = renderToStaticMarkup(<AdminNav current="/admin/review" badges={{ '/admin/status': countBadge(3, 'critical') }} />);
    expect(html).toMatch(/href="\/admin\/flow"[^]*?data-tone="critical">3<\/b>/);
    expect(html.match(/class="nav-badge"/g)).toHaveLength(1);
  });

  it('사람 확인에는 직접 판단 수와 내릴 후보 배지(요청·감사 적체)를 함께 붙이되 합하지 않는다', () => {
    const human = countBadge(4440, 'warn', n => `직접 판단 ${n}건`);
    const audit = auditBadge({ pending: 2, overdue: 1 }, 1, { overdue: 553, oldestWaitDays: 27 });
    expect(workspaceBadge('people', { '/admin/review': human, '/admin/audit': audit })).toEqual({ label: '2곳', tone: 'critical',
      title: '심사 큐: 직접 판단 4,440건 · 내릴 후보: 내려달라는 요청 2건(24시간 넘음 1건) · 소개 수정 요청 1건 · 감사 거절 7일 넘게 기다림 553건(가장 오래 27일)' });
    // 감사 적체만 있으면 그 수 그대로(주황)
    const backlog = auditBadge(null, 0, { overdue: 553, oldestWaitDays: 27 });
    expect(workspaceBadge('people', { '/admin/audit': backlog })).toEqual(backlog);
    // 다른 메뉴에는 붙지 않는다
    for (const id of ['home', 'models', 'sources', 'content', 'log'] as const) expect(workspaceBadge(id, { '/admin/review': human, '/admin/audit': audit })).toBeUndefined();
  });

  it('does not add overlapping requests, projects or alert units', () => {
    expect(workspaceBadge('people', {
      '/admin/requests': { label: '4', tone: 'warn', title: '열린 문의 4건' },
      '/admin/feedback': { label: '2', tone: 'critical', title: '피드백 보류 2건' },
    })).toEqual({ label: '2곳', tone: 'critical', title: '문의 접수: 열린 문의 4건 · 피드백 검수: 피드백 보류 2건' });
  });
});
