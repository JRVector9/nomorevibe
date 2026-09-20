import { expect, test } from '@playwright/test';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates } from '@/lib/db/schema';
import { SESSION_COOKIE, signSession } from '@/lib/auth/session';
import { ensureSchema } from '../integration/setup';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  ensureSchema();
  await db.delete(crawlCandidates);
  await db.execute(sql`truncate crawl_publication_changes restart identity`);
  await db.insert(crawlCandidates).values([
    { repo: 'change/one', state: 'published' }, { repo: 'change/two', state: 'published' },
  ]);
});
test.beforeEach(async ({context, baseURL}) => {
  await context.addCookies([{name: SESSION_COOKIE, value: await signSession('playwright-admin', 'playwright-auth-secret-with-at-least-32-characters'), url: baseURL!, httpOnly: true, sameSite: 'Lax'}]);
});
test('shows positive 24-hour change on desktop and mobile without browser errors', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/admin/review');
  await page.waitForLoadState('networkidle');
  const stages = page.getByRole('navigation', { name: '심사 구간' });
  await expect(stages.getByLabel('최근 24시간 발행 완료 +2건')).toHaveText('(+2)');
  await stages.screenshot({path: 'test-results/review-change-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await expect(stages.getByLabel('최근 24시간 발행 완료 +2건')).toBeVisible();
  await stages.screenshot({path: 'test-results/review-change-mobile.png'});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
test('shows a negative change when a previously published candidate leaves the state', async ({page}) => {
  await db.execute(sql`update crawl_publication_changes set occurred_at = (current_timestamp at time zone 'UTC') - interval '25 hours'`);
  await db.update(crawlCandidates).set({state:'rejected'}).where(eq(crawlCandidates.repo,'change/one'));
  await page.goto('/admin/review');
  await expect(page.getByLabel('최근 24시간 발행 완료 -1건')).toHaveText('(-1)');
});
