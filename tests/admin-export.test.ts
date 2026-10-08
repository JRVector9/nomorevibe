import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), log: vi.fn(), news: vi.fn(), products: vi.fn(), activity: vi.fn() }));
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin }));
vi.mock('@/lib/operations/admin-log', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/operations/admin-log')>(), recordAdminAction: mocks.log,
}));
vi.mock('@/app/admin/news/list', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/admin/news/list')>(), listNewsPage: mocks.news,
}));
vi.mock('@/app/admin/activity/query', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/admin/activity/query')>(), activityLog: mocks.activity,
}));
vi.mock('@/lib/domain/products/repository', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/domain/products/repository')>(), listProducts: mocks.products,
}));

import { GET } from '@/app/admin/export/route';
import { CSV_BOM, csvCell, toCsv } from '@/app/admin/export/csv';
import { MAX_EXPORT_ROWS } from '@/app/admin/export/views';

const call = (query: string) => GET(new Request(`http://localhost:3476/admin/export?${query}`), { params: Promise.resolve({}) });
const newsRow = (id: number, title = `글 ${id}`) => ({
  id, sourceKey: 'openai-news', title, url: `https://news.test/${id}`, publishedAt: new Date('2026-10-08T04:38:13Z'),
  state: 'pending', decidedBy: null, decidedAt: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: 'jr' });
  mocks.news.mockResolvedValue([newsRow(1)]);
});

describe('CSV 칸', () => {
  it('수식으로 시작하는 글자는 앞에 따옴표를 붙여 글자로 둔다 — 숫자는 그대로', () => {
    for (const value of ['=HYPERLINK("http://x")', '+1', '-2+3', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(value).replace(/^"/, '')).toMatch(/^'/);
    expect(csvCell(-1)).toBe('-1');
    expect(csvCell(0.95)).toBe('0.95');
    expect(csvCell('보통 이름')).toBe('보통 이름');
  });

  it('따옴표·쉼표·줄바꿈은 큰따옴표로 감싸고 안의 따옴표는 두 번 쓴다', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('그가 "좋다"')).toBe('"그가 ""좋다"""');
    expect(csvCell('한 줄\n두 줄')).toBe('"한 줄\n두 줄"');
    expect(csvCell('=1,2')).toBe('"\'=1,2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('엑셀이 한글을 읽도록 BOM 으로 시작하고 줄은 CRLF', () => {
    const csv = toCsv([{ label: '이름', value: (row: { name: string }) => row.name }], [{ name: '가' }, { name: '나' }]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toBe(`${CSV_BOM}이름\r\n가\r\n나\r\n`);
  });
});

describe('GET /admin/export', () => {
  it('관리자가 아니면 읽지도 기록하지도 않는다', async () => {
    mocks.admin.mockResolvedValue(null);
    const response = await call('view=news&format=csv');
    expect(response.status).toBe(403);
    expect(mocks.news).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it('모르는 화면·형식은 400 — 프로토타입 키도', async () => {
    expect((await call('view=constructor&format=csv')).status).toBe(400);
    expect((await call('view=news&format=xlsx')).status).toBe(400);
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it('화면의 거르기 그대로 읽어 CSV 로 내려 주고, 내보낸 사실을 작업 로그에 남긴다', async () => {
    mocks.news.mockResolvedValue([newsRow(1, '=cmd|"/c calc"!A1'), newsRow(2)]);
    const response = await call('view=news&format=csv&state=pending&page=3');
    expect(mocks.news).toHaveBeenCalledWith('pending', { limit: MAX_EXPORT_ROWS + 1, offset: 0 });
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="nomorevibe-news-\d{8}-\d{4}\.csv"$/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    // Response.text() 는 BOM 을 떼고 돌려준다 — 바이트로 본다
    expect(body.split('\r\n')[0]).toBe('id,출처,제목,주소,게시,상태,정한 사람,정한 시각');
    expect(body).toContain(`"'=cmd|""/c calc""!A1"`);
    expect(body).toContain('2026-10-08 13:38:13 KST');
    expect(mocks.log).toHaveBeenCalledWith('jr', { action: 'export', target: 'export:news',
      detail: { format: 'csv', filters: { state: 'pending', page: '3' }, rows: 2, truncated: false } });
  });

  it('BOM 이 실제 바이트 맨 앞에 있다', async () => {
    const bytes = new Uint8Array(await (await call('view=news&format=csv')).arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('최대 10,000행 — 넘치면 자르고 잘렸다고 알린다', async () => {
    mocks.news.mockResolvedValue(Array.from({ length: MAX_EXPORT_ROWS + 1 }, (_, i) => newsRow(i + 1)));
    const response = await call('view=news&format=json');
    expect(response.headers.get('x-export-truncated')).toBe('1');
    const json = await response.json();
    expect(json).toMatchObject({ view: 'news', rows: MAX_EXPORT_ROWS, truncated: true, limit: 10_000 });
    expect(json.items).toHaveLength(MAX_EXPORT_ROWS);
    expect(json.items[0]).toMatchObject({ id: 1, title: '글 1', state: '대기' });
    expect(mocks.log).toHaveBeenCalledWith('jr', expect.objectContaining({ detail: expect.objectContaining({ rows: MAX_EXPORT_ROWS, truncated: true }) }));
  });

  it('제품은 제품 관리의 거르기(filter·q·sort)를 그대로 쓴다', async () => {
    mocks.products.mockResolvedValue([]);
    await call('view=products&format=csv&filter=응답 없음&q= foo &sort=stars&page=2');
    expect(mocks.products).toHaveBeenCalledWith(expect.objectContaining({
      statuses: ['seeded', 'verified'], down: true, adminSearch: 'foo', sort: 'stars', limit: MAX_EXPORT_ROWS + 1, offset: 0,
    }));
    await call('view=products&format=csv&filter=constructor');
    expect(mocks.products).toHaveBeenLastCalledWith(expect.objectContaining({ statuses: ['verified', 'seeded', 'unverified', 'banned'], sort: 'recent' }));
  });

  it('작업 로그는 대상 거르기까지 같고 쪽 넘김(before)은 무시한다', async () => {
    mocks.activity.mockResolvedValue([]);
    await call('view=activity&format=csv&group=takedown&target=acme/tool&before=50');
    expect(mocks.activity).toHaveBeenCalledWith(expect.objectContaining({ target: 'acme/tool', before: undefined,
      actions: expect.arrayContaining(['audit-remove']) }), MAX_EXPORT_ROWS + 1);
  });
});
