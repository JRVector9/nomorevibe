import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdminNav, auditBadge, countBadge, NAV_GROUPS, workspaceBadge } from '@/app/(operator)/admin/AdminNav';
import { WorkspaceTabs } from '@/app/(operator)/admin/components/WorkspaceTabs';
import { resolveWorkspace, secondaryIsActive, WORKSPACE_GROUPS, WORKSPACE_LEGACY_SCREENS, WORKSPACES } from '@/app/(operator)/admin/workspace-navigation';

const query = (raw = '') => new URLSearchParams(raw);
const activeLinks = (html: string) => (html.match(/<a\b[^>]*>/g) ?? []).filter(tag => tag.includes('aria-current="page"'));
const expectActiveLink = (html: string, href: string) => expect(activeLinks(html)).toEqual(expect.arrayContaining([expect.stringContaining(`href="${href}"`)]));

describe('seven operational workspaces', () => {
  it('renders five daily destinations and two supporting destinations', () => {
    expect(WORKSPACE_GROUPS.map(group => group.title)).toEqual(['매일 운영', '필요할 때']);
    expect(WORKSPACE_GROUPS.map(group => group.pages.length)).toEqual([5, 2]);
    expect(WORKSPACES.map(page => page.label)).toEqual(['운영 홈', '검수 및 발행', '요청함', '프로젝트', 'LLM 운영', '콘텐츠 운영', '설정·기록']);
    const html = renderToStaticMarkup(<AdminNav current="/admin/flow" />);
    expect(html.match(/href="\/admin/g)).toHaveLength(7);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).not.toContain('<small>');
    expectActiveLink(html, '/admin/flow');
  });

  it('preserves the legacy inventory while moving its screens to workspace tabs', () => {
    expect(NAV_GROUPS.flatMap(group => group.pages).map(page => page.href)).toEqual(expect.arrayContaining(['/admin/models/devices', '/admin/models/helpers', '/admin/models/assignments', '/admin/activity']));
    expect(WORKSPACE_LEGACY_SCREENS).toHaveLength(30);
    expect(new Set(WORKSPACE_LEGACY_SCREENS).size).toBe(30);
    for (const path of WORKSPACE_LEGACY_SCREENS.filter(path => path !== '/admin/login')) {
      expect(resolveWorkspace(path).workspace.id, path).toBeTruthy();
    }
  });

  it.each([
    ['/admin/products/example', '', 'projects', 'all'],
    ['/admin/products/recheck', '', 'projects', 'quality'],
    ['/admin/audit', 'tab=audit', 'projects', 'quality'],
    ['/admin/audit', 'tab=policy', 'projects', 'quality'],
    ['/admin/audit', 'tab=requests', 'requests', 'correction'],
    ['/admin/review', 'second=published', 'projects', 'quality'],
    ['/admin/status', 'tab=manual', 'review', 'publish'],
    ['/admin/status', 'tab=crawlers', 'home', 'diagnostics'],
    ['/admin/review', 'stage=human', 'review', 'human'],
    ['/admin/review', 'stage=agreed', 'review', 'human'],
    ['/admin/review', 'stage=publish', 'review', 'publish'],
    ['/admin/review', 'state=approved', 'review', 'publish'],
    ['/admin/review', 'stage=rejected', 'review', 'rejected'],
    ['/admin/review', '', 'review', 'human'],
    ['/admin/requests', 'tab=registration', 'requests', 'registration'],
    ['/admin/requests', 'tab=history', 'requests', 'history'],
    ['/admin/requests', 'state=all', 'requests', 'contact'],
    ['/admin/requests', 'offset=20', 'requests', 'contact'],
    ['/admin/requests', 'state=&offset=', 'requests', 'contact'],
    ['/admin/requests', 'tab=posts&state=held', 'requests', 'posts'],
    ['/admin/requests', 'tab=open&offset=20', 'requests', 'open'],
    ['/admin/requests', 'tab=unknown&state=all', 'requests', 'open'],
    ['/admin/requests', 'tab=&offset=20', 'requests', 'open'],
    ['/admin/requests', 'tab=constructor', 'requests', 'open'],
    ['/admin/maker-replies', '', 'requests', 'posts'],
    ['/admin/reactions', '', 'requests', 'posts'],
    // 2026-11-07 LLM 운영 개편: 드물게 쓰는 편집기는 「고급 설정」 아래로
    ['/admin/models/assignments', '', 'models', 'advanced'],
    ['/admin/models/helpers', '', 'models', 'advanced'],
    ['/admin/models/limits', '', 'models', 'advanced'],
    ['/admin/models/contracts', '', 'models', 'advanced'],
    ['/admin/models/llm', '', 'models', 'llm'],
    ['/admin/models/history', '', 'models', 'history'],
    ['/admin/talk', '', 'content', 'social'],
    ['/admin/news', '', 'content', 'news'],
    ['/admin/ranking', '', 'content', 'ranking'],
    ['/admin/content', 'tab=news', 'content', 'news'],
    ['/admin/content', 'tab=unknown', 'content', 'social'],
    ['/admin/settings', 'tab=integrations', 'settings', 'integrations'],
    ['/admin/categories', '', 'settings', 'evidence'],
    ['/admin/github-accounts', '', 'settings', 'integrations'],
    ['/admin/activity', 'workspace=home&group=settings', 'home', 'changes'],
    ['/admin/activity', 'workspace=models&group=settings', 'models', 'history'],
    ['/admin/activity', 'workspace=projects', 'settings', 'history'],
    ['/admin', '', 'settings', 'collection'],
  ])('owns %s?%s as %s/%s', (path, search, owner, tab) => {
    const location = resolveWorkspace(path, query(search));
    expect(location.workspace.id).toBe(owner);
    expect(location.tab).toBe(tab);
    const html = renderToStaticMarkup(<AdminNav current={path} search={search} />);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expectActiveLink(html, location.workspace.href);
  });

  it('preserves the identity of project detail without giving generic pages another masthead', () => {
    expect(resolveWorkspace('/admin/products/example').detail).toBe('product');
    expect(resolveWorkspace('/admin/products/recheck').detail).toBeNull();
    expect(resolveWorkspace('/admin/models').detail).toBeNull();
  });
});

describe('workspace tabs and legacy deep links', () => {
  it('selects the advanced-settings tab and keeps every advanced editor reachable', () => {
    const location = resolveWorkspace('/admin/models/helpers');
    const html = renderToStaticMarkup(<WorkspaceTabs location={location} pathname="/admin/models/helpers" search="" />);
    for (const href of ['/admin/models?advanced=1', '/admin/models/devices', '/admin/models/limits', '/admin/models/helpers', '/admin/models/assignments',
      '/admin/models/contracts', '/admin/models/human', '/admin/models/search']) expect(html).toContain(`href="${href}"`);
    expectActiveLink(html, '/admin/models?advanced=1');
    expectActiveLink(html, '/admin/models/helpers');
    for (const label of ['대시보드', 'LLM 운영', '작업 배정', '기록', '고급 설정']) expect(html).toContain(`>${label}</a>`);
  });

  it('keeps published second review, audit policies and rule recheck separate', () => {
    const pathname = '/admin/review', search = 'second=published';
    const html = renderToStaticMarkup(<WorkspaceTabs location={resolveWorkspace(pathname, query(search))} pathname={pathname} search={search} />);
    expect(html).toContain('/admin/audit?tab=audit');
    expect(html).toContain('/admin/products/recheck');
    expectActiveLink(html, '/admin/review?second=published');
    expect(html).toContain('공개분');
  });

  it('matches query values instead of treating every audit URL as the same detail', () => {
    const item = { id: 'requests', label: '내림·수정', href: '/admin/audit?tab=requests' };
    expect(secondaryIsActive(item, '/admin/audit', query('tab=requests'))).toBe(true);
    expect(secondaryIsActive(item, '/admin/audit', query('tab=audit'))).toBe(false);
  });

  it('keeps the actionable inbox and change log separately reachable', () => {
    const pathname = '/admin/inbox';
    const html = renderToStaticMarkup(<WorkspaceTabs location={resolveWorkspace(pathname)} pathname={pathname} search="" />);
    expect(html).toContain('href="/admin/inbox"');
    expect(html).toContain('href="/admin/activity?workspace=home&amp;group=settings"');
    expectActiveLink(html, '/admin/inbox');
  });

  it('keeps audit policy inside the AI audit secondary tab', () => {
    const link = { id: 'audit', label: 'AI 감사·정책', href: '/admin/audit?tab=audit' };
    expect(secondaryIsActive(link, '/admin/audit', query('tab=policy'))).toBe(true);
    expect(secondaryIsActive(link, '/admin/audit', query())).toBe(true);
    expect(secondaryIsActive(link, '/admin/audit', query('tab=requests'))).toBe(false);
  });

  it.each(['evidence', 'integrations'])('lets canonical settings render its own %s subnavigation', tab => {
    const pathname = '/admin/settings', search = `tab=${tab}`;
    const location = resolveWorkspace(pathname, query(search));
    expect(location.tab).toBe(tab);
    expect(location.secondary).toEqual([]);
    const html = renderToStaticMarkup(<WorkspaceTabs location={location} pathname={pathname} search={search} />);
    expect(html).not.toContain('admin-workspace-secondary');
  });

  it('lets canonical post review render its own kind tabs', () => {
    const pathname = '/admin/requests', search = 'tab=posts&kind=feedback';
    const location = resolveWorkspace(pathname, query(search));
    expect(location.tab).toBe('posts');
    expect(location.secondary).toEqual([]);
    const html = renderToStaticMarkup(<WorkspaceTabs location={location} pathname={pathname} search={search} />);
    expect(html).not.toContain('admin-workspace-secondary');
  });

  it.each(['/admin/feedback', '/admin/maker-replies', '/admin/reactions'])('preserves every legacy post review link on %s', pathname => {
    const location = resolveWorkspace(pathname);
    const html = renderToStaticMarkup(<WorkspaceTabs location={location} pathname={pathname} search="" />);
    for (const href of ['/admin/feedback', '/admin/maker-replies', '/admin/reactions']) expect(html).toContain(`href="${href}"`);
    expectActiveLink(html, pathname);
  });

  it.each([
    ['/admin/categories', '/admin/evidence'],
    ['/admin/evidence', '/admin/categories'],
    ['/admin/github-accounts', '/admin/github-integrations'],
    ['/admin/github-integrations', '/admin/github-accounts'],
  ])('keeps sibling settings screens reachable on legacy %s', (pathname, sibling) => {
    const location = resolveWorkspace(pathname);
    const html = renderToStaticMarkup(<WorkspaceTabs location={location} pathname={pathname} search="" />);
    expect(html).toContain('admin-workspace-secondary');
    expect(html).toContain(`href="${sibling}"`);
    expectActiveLink(html, pathname);
  });
});

describe('workspace badge units', () => {
  it('keeps a single count and accessible description', () => {
    const badge = countBadge(1234, 'warn', n => `직접 판단 ${n}건`);
    expect(countBadge(0, 'warn')).toBeUndefined();
    expect(countBadge(null, 'critical')).toBeUndefined();
    expect(workspaceBadge('review', { '/admin/review': badge })).toEqual(badge);
    const html = renderToStaticMarkup(<AdminNav current="/admin/flow" badges={{ '/admin/review': badge }} />);
    expect(html).toContain('<span class="admin-vh">직접 판단 1,234건</span>');
  });

  it('shows operations alarms on the home destination', () => {
    const html = renderToStaticMarkup(<AdminNav current="/admin/review" badges={{ '/admin/status': countBadge(3, 'critical') }} />);
    expect(html).toMatch(/href="\/admin\/flow"[^]*?data-tone="critical">3<\/b>/);
  });

  it('does not add overlapping requests, projects or alert units', () => {
    expect(workspaceBadge('requests', {
      '/admin/requests': { label: '4', tone: 'warn', title: '열린 문의 4건' },
      '/admin/feedback': { label: '2', tone: 'critical', title: '피드백 보류 2건' },
    })).toEqual({ label: '2곳', tone: 'critical', title: '문의 접수: 열린 문의 4건 · 피드백 검수: 피드백 보류 2건' });
  });

  it('routes audit request counts and audit backlog to their own workspace', () => {
    const requests = auditBadge({ pending: 2, overdue: 1 }, 1, { overdue: 800, oldestWaitDays: 12 });
    expect(workspaceBadge('requests', { '/admin/audit': requests })).toEqual({ label: '3', tone: 'critical', title: '내려달라는 요청 2건(24시간 넘음 1건) · 소개 수정 요청 1건' });
    expect(workspaceBadge('projects', { '/admin/audit': requests })).toEqual({ label: '확인', tone: 'warn', title: '감사 거절 7일 넘게 기다림 800건(가장 오래 12일)' });
    expect(workspaceBadge('requests', { '/admin/audit': auditBadge(null, 0, { overdue: 20, oldestWaitDays: 8 }) })).toBeUndefined();
    expect(workspaceBadge('projects', { '/admin/audit': auditBadge(null, 1) })).toBeUndefined();
  });
});


describe('approved prototype workspace tabs', () => {
  it.each([
    ['/admin/flow', 'diagnostics', 'home'], ['/admin/flow', 'changes', 'home'],
    ['/admin/products', 'quality', 'projects'], ['/admin/products', 'translations', 'projects'],
  ])('keeps %s?tab=%s inside the designed workspace', (pathname, tab, owner) => {
    const location = resolveWorkspace(pathname, query(`tab=${tab}`));
    expect(location.workspace.id).toBe(owner); expect(location.tab).toBe(tab);
    expect(location.secondary).toEqual([]);
    const html = renderToStaticMarkup(<WorkspaceTabs location={location} pathname={pathname} search={`tab=${tab}`} />);
    expectActiveLink(html, `${pathname}?tab=${tab}`);
  });
});

describe('LLM 운영 tabs after the 2026-11-07 redesign', () => {
  it.each([
    ['tasks', 'tasks', '/admin/models/tasks'], ['capacity', 'llm', '/admin/models/llm'],
    ['connections', 'llm', '/admin/models/llm'], ['history', 'history', '/admin/models/history'], ['live', 'dashboard', '/admin/models'],
  ])('maps the old /admin/models?tab=%s to the %s tab', (tab, mapped, href) => {
    const location = resolveWorkspace('/admin/models', query(`tab=${tab}`));
    expect(location.workspace.id).toBe('models'); expect(location.tab).toBe(mapped);
    expect(location.secondary).toEqual([]);
    const html = renderToStaticMarkup(<WorkspaceTabs location={location} pathname="/admin/models" search={`tab=${tab}`} />);
    expectActiveLink(html, href);
  });
});

it('keeps agreed and direct decisions together in the canonical human tab', () => {
  const review = WORKSPACES.find(workspace => workspace.id === 'review')!;
  expect(review.tabs.find(tab => tab.id === 'human')?.href).toBe('/admin/review?tab=human');
  expect(resolveWorkspace('/admin/review', query('stage=human')).tab).toBe('human');
});
