import {expect, test} from '@playwright/test';
import {eq} from 'drizzle-orm';
import {db} from '@/lib/db';
import {crawlSettings} from '@/lib/db/schema';
import {DEFAULT_CRAWL_SETTINGS} from '@/lib/crawl/settings-schema';
import {mergeWithDefaults, settingsFormVersion} from '@/lib/crawl/settings';
import {shortSettingsVersion, storedSettingsVersion} from '@/lib/crawl/settings-version';
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
  const formVersion=page.locator('input[name="settingsVersion"]');
  const initialVersion=await formVersion.getAttribute('value');
  expect(initialVersion).toMatch(/^[a-f0-9]{32}$/);
  const section=page.locator('#second');
  await section.getByRole('button',{name:'+ 대체 모델 더하기',exact:true}).click();
  await page.locator('[name="fallbackProvider0"]').selectOption('claude-cli');
  await page.locator('[name="fallbackModel0"]').fill('sonnet');
  const [response]=await Promise.all([
    page.waitForResponse(response=>new URL(response.url()).pathname==='/admin'
      && response.request().method()==='POST' && Boolean(response.request().headers()['next-action'])),
    page.getByRole('button',{name:'저장 — 다음 틱부터 적용',exact:true}).click(),
  ]);
  expect(response.status()).toBe(200);
  // A 200 action response can also contain validation errors. Prove the exact
  // write and both updated versions without depending on RSC response bytes.
  await expect.poll(async()=>{
    const [saved]=await db.select().from(crawlSettings).where(eq(crawlSettings.id,1));
    return (saved.values as typeof DEFAULT_CRAWL_SETTINGS).secondReview.fallbacks;
  }).toEqual([{provider:'claude-cli',model:'sonnet'}]);
  const [saved]=await db.select().from(crawlSettings).where(eq(crawlSettings.id,1));
  expect((saved.values as typeof DEFAULT_CRAWL_SETTINGS).secondReview.fallbacks).toEqual([{provider:'claude-cli',model:'sonnet'}]);
  const savedFormVersion=settingsFormVersion(mergeWithDefaults(saved.values));
  expect(savedFormVersion).not.toBe(initialVersion);
  await expect(formVersion).toHaveValue(savedFormVersion);
  await expect(page.locator('#apply')).toContainText(`저장 판 ${shortSettingsVersion(storedSettingsVersion(saved.values))}`);
  await page.reload();
  await expect(page.locator('[name="fallbackModel0"]')).toHaveValue('sonnet');
  await expect(page.locator('[name="fallbackProvider0"]')).toHaveValue('claude-cli');
  await expect(section.locator('[name="fallbackModel1"]')).toHaveCount(0);
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({path:'.crawl-samples/fallback-settings-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({path:'.crawl-samples/fallback-settings-mobile.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
