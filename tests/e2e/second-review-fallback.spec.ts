import {expect, test} from '@playwright/test';
import {eq} from 'drizzle-orm';
import {db} from '@/lib/db';
import {crawlSettings} from '@/lib/db/schema';
import {DEFAULT_CRAWL_SETTINGS} from '@/lib/crawl/settings-schema';
import {SESSION_COOKIE, signSession} from '@/lib/auth/session';
import {ensureSchema} from '../integration/setup';

test.beforeAll(async () => {
  ensureSchema();
  const values = {...DEFAULT_CRAWL_SETTINGS, secondReview:{...DEFAULT_CRAWL_SETTINGS.secondReview,
    voters:[{provider:'abcllm' as const,model:'[MLX] qwen3.8-27b'},{provider:'abcllm' as const,model:'[MLX] gpt-oss-120b'}],fallbacks:[]}};
  await db.insert(crawlSettings).values({id:1,values}).onConflictDoUpdate({target:crawlSettings.id,set:{values}});
});

test('관리자가 대체 모델을 저장하고 다시 열어도 공급자와 순서가 유지된다', async ({page,context,baseURL}) => {
  await context.addCookies([{name:SESSION_COOKIE,value:await signSession('playwright-admin','playwright-auth-secret-with-at-least-32-characters'),url:baseURL!,httpOnly:true,sameSite:'Lax'}]);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/admin');
  await page.locator('[name="fallbackProvider0"]').selectOption('claude-cli');
  await page.locator('[name="fallbackModel0"]').fill('opus');
  await page.getByRole('button',{name:'저장',exact:true}).click();
  await expect(page.getByText('저장했습니다. 다음 틱부터 적용됩니다.')).toBeVisible();
  const [saved]=await db.select().from(crawlSettings).where(eq(crawlSettings.id,1));
  expect((saved.values as typeof DEFAULT_CRAWL_SETTINGS).secondReview.fallbacks).toEqual([{provider:'claude-cli',model:'opus'}]);
  await page.reload();
  await expect(page.locator('[name="fallbackModel0"]')).toHaveValue('opus');
  await expect(page.locator('[name="fallbackProvider0"]')).toHaveValue('claude-cli');
  await expect(page.locator('[name="fallbackModel1"]')).toHaveValue('');
  const fieldset=page.locator('fieldset').filter({hasText:'실패 시 대체 모델'});
  await fieldset.scrollIntoViewIfNeeded();
  await fieldset.screenshot({path:'.crawl-samples/fallback-settings-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await fieldset.scrollIntoViewIfNeeded();
  await fieldset.screenshot({path:'.crawl-samples/fallback-settings-mobile.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
