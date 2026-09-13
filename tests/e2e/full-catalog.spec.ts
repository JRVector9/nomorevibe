import { test, expect } from '@playwright/test';
import { db } from '@/lib/db';
import { products, productHealth, rankingSeasons, rankingPolicyRevisions } from '@/lib/db/schema';
import { DEFAULT_RANKING_POLICY } from '@/lib/domain/ranking/policy';
import { ensureSchema, resetTables } from '../integration/setup';

test.beforeAll(async () => {
  ensureSchema(); await resetTables();
  const createdAt = new Date('2026-09-01T00:00:00Z');
  const rows = Array.from({ length: 124 }, (_, i) => {
    const number = String(i + 1).padStart(3, '0');
    return { slug: `directory-${number}`, name: `Directory Project ${number}`, url: `https://directory-${number}.example`, tagline: 'A useful project in the complete catalogue', description: 'Directory tools', category: i < 117 || i >= 122 ? 'Dev' as const : 'Design' as const, status: i === 123 ? 'banned' as const : 'seeded' as const, source: 'crawler' as const, createdAt, verifyToken: 'v', editTokenHash: 'e' };
  });
  await db.insert(products).values(rows);
  await db.insert(productHealth).values({ slug: 'directory-123', status: 503, failures: 3 });
  const [revision] = await db.insert(rankingPolicyRevisions).values({ values: DEFAULT_RANKING_POLICY, state: 'applied', createdBy: 'playwright' }).returning();
  await db.insert(rankingSeasons).values({ key: 'full-catalog-season', cadence: 'weekly', startsAt: createdAt, endsAt: new Date('2027-01-01T00:00:00Z'), state: 'active', policyRevisionId: revision.id, policySnapshot: DEFAULT_RANKING_POLICY, effectiveLaunchWindowDays: 28 });
});

test('public filtered catalogue crosses 100 and reaches the final project', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?sort=recent&q=directory&category=Dev');
  await expect(page.locator('.project-card')).toHaveCount(9);
  await expect(page.getByRole('link', { name: '프로젝트 더 보기 (9 / 117)' })).toBeVisible();
  await expect(page.locator('.project-title')).toHaveText(Array.from({length:9},(_,i)=>`Directory Project ${String(i+1).padStart(3,'0')}`));
  await page.goto('/?sort=recent&q=directory&category=Dev&shown=99');
  await expect(page.locator('.project-card')).toHaveCount(99);
  await page.getByRole('link', { name: '프로젝트 더 보기 (99 / 117)' }).click();
  await expect(page.locator('.project-card')).toHaveCount(108);
  expect(new URL(page.url()).searchParams.get('q')).toBe('directory');
  expect(new URL(page.url()).searchParams.get('category')).toBe('Dev');
  await page.getByRole('link', { name: '프로젝트 더 보기 (108 / 117)' }).click();
  await expect(page.locator('.project-card')).toHaveCount(117);
  await expect(page.getByRole('heading', { name: 'Directory Project 117', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /프로젝트 더 보기/ })).toHaveCount(0);
  const names = await page.locator('.project-title').allTextContents(); expect(new Set(names).size).toBe(117);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'/tmp/nomorevibe-full-catalog-mobile.png'});
  await page.goto('/?sort=recent&q=directory&category=Dev&shown=9000000000000');
  await expect(page.locator('.project-card')).toHaveCount(117);
  expect(errors).toEqual([]);
});

test('the default unclaimed list also continues beyond 100', async ({page})=>{
  await page.goto('/?sort=weekly&q=directory&category=Dev&shown=99');
  const fill=page.locator('.unclaimed-block');await expect(fill.locator('.project-card')).toHaveCount(99);
  await fill.getByRole('link',{name:'프로젝트 더 보기 (99 / 117)'}).click();await expect(fill.locator('.project-card')).toHaveCount(108);
});
