import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { applyChanges, planCategoryChanges, planNameChanges, reverse } from '@/lib/crawl/tidy-catalog';
import { ensureSchema, resetTables } from './setup';

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

let serial = 0;
async function product(values: { name: string; category?: string; status?: 'seeded' | 'verified'; source?: 'crawler' | 'skill'; repo?: string }) {
  serial += 1;
  const slug = `p-${serial}`;
  await db.insert(products).values({
    slug, url: `https://p${serial}.test`, name: values.name, tagline: '소개', description: '설명', category: values.category ?? 'Dev',
    status: values.status ?? 'seeded', source: values.source ?? 'crawler', repoUrl: values.repo ? `https://github.com/${values.repo}` : null,
    verifyToken: `v-${serial}`, editTokenHash: 'x'.repeat(64),
  });
  return slug;
}

async function row(slug: string) {
  const [found] = await db.select().from(products).where(eq(products.slug, slug));
  return found;
}

it('크롤러가 올린 것의 문장 이름만 고친다 — 주인이 있는 것은 두고, 멀쩡한 이름은 목록에 넣지 않는다', async () => {
  const long = await product({ name: 'Radiant: your whole coding stack, in one window', repo: 'acme/radiant' });
  const generic = await product({ name: 'Sign in', repo: 'acme/tradeflow-wms' });
  await product({ name: 'Taskly', repo: 'acme/taskly' });
  await product({ name: 'Radiant: your whole coding stack, in one window', repo: 'acme/radiant', status: 'verified', source: 'skill' });

  expect(await planNameChanges()).toEqual([
    { slug: long, field: 'name', before: 'Radiant: your whole coding stack, in one window', after: 'Radiant' },
    { slug: generic, field: 'name', before: 'Sign in', after: 'tradeflow-wms' },
  ]);
});

it('기타만 다시 분류하고, 여전히 기타이거나 답이 없으면 그대로 둔다', async () => {
  const study = await product({ name: 'SkillGAP', category: 'Other', repo: 'acme/skillgap' });
  const personal = await product({ name: 'Michael Leung', category: 'Other', repo: 'mleung/home' });
  const failed = await product({ name: 'Mystery', category: 'Other', repo: 'acme/mystery' });
  await product({ name: 'Already Dev', category: 'Dev', repo: 'acme/dev' });
  const classify = vi.fn(async (inputs: { name: string }[]) => inputs.map((input) =>
    input.name === 'SkillGAP' ? 'Education' as const : input.name === 'Michael Leung' ? 'Other' as const : null));

  const changes = await planCategoryChanges(classify, { names: new Map([[study, 'SkillGAP']]) });

  expect(changes).toEqual([{ slug: study, field: 'category', before: 'Other', after: 'Education', label: 'SkillGAP' }]);
  // 기타가 아닌 것은 분류기에 보내지 않는다
  expect(classify.mock.calls.flatMap(([inputs]) => inputs.map((input) => input.name)).sort()).toEqual(['Michael Leung', 'Mystery', 'SkillGAP']);
  expect((await row(personal)).category).toBe('Other');
  expect((await row(failed)).category).toBe('Other');
});

it('정리한 이름으로 분류한다 — 문장이 된 이름이 분류를 흐리지 않게', async () => {
  const slug = await product({ name: 'Two Prices for the Same Model: Building Claude Burst', category: 'Other', repo: 'acme/claude-burst' });
  const classify = vi.fn(async (inputs: { name: string; repo: string }[]) => inputs.map(() => 'Dev' as const));

  await planCategoryChanges(classify, { names: new Map([[slug, 'Claude Burst']]) });

  expect(classify).toHaveBeenCalledWith([expect.objectContaining({ name: 'Claude Burst', repo: 'acme/claude-burst' })]);
});

it('계획대로 바꾸고, 그 사이 누가 고친 것은 건너뛰고, 같은 파일로 되돌린다', async () => {
  const a = await product({ name: 'Radiant: your whole coding stack', category: 'Other', repo: 'acme/radiant' });
  const b = await product({ name: 'OpenLimiter, quota awareness for AI coding agents', repo: 'acme/openlimiter' });
  const plan = [
    { slug: a, field: 'name' as const, before: 'Radiant: your whole coding stack', after: 'Radiant' },
    { slug: a, field: 'category' as const, before: 'Other', after: 'Dev' },
    { slug: b, field: 'name' as const, before: 'OpenLimiter, quota awareness for AI coding agents', after: 'OpenLimiter' },
  ];
  // 계획을 세운 뒤 누가 b 의 이름을 고쳤다
  await db.update(products).set({ name: 'OpenLimiter by Acme' }).where(eq(products.slug, b));

  expect(await applyChanges(plan)).toEqual({ applied: 2, skipped: 1 });
  expect(await row(a)).toMatchObject({ name: 'Radiant', category: 'Dev' });
  expect((await row(b)).name).toBe('OpenLimiter by Acme');

  expect(await applyChanges(reverse(plan))).toEqual({ applied: 2, skipped: 1 });
  expect(await row(a)).toMatchObject({ name: 'Radiant: your whole coding stack', category: 'Other' });
  expect((await row(b)).name).toBe('OpenLimiter by Acme');
});

it('주인이 생긴 것은 계획에 있어도 바꾸지 않는다', async () => {
  const slug = await product({ name: 'Radiant: your whole coding stack', repo: 'acme/radiant' });
  await db.update(products).set({ status: 'verified' }).where(eq(products.slug, slug));

  expect(await applyChanges([{ slug, field: 'name', before: 'Radiant: your whole coding stack', after: 'Radiant' }])).toEqual({ applied: 0, skipped: 1 });
});
