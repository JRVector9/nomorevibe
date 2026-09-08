/** Verify the ten actually recollected products through the rendered local application. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const input = process.argv[2] ?? 'docs/reviews/2026-09-06-agent-live-10.json';
const output = process.argv[3] ?? 'docs/reviews/2026-09-06-agent-live-browser.json';
const report = JSON.parse(await readFile(input, 'utf8'));
assert.equal(report.selectedCount, 10);
assert.equal(report.products.length, 10);
assert.ok(report.completedAt, 'collection must finish before browser acceptance');
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const product of report.products) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const response = await page.goto(`http://localhost:3000/p/${product.slug}`);
    await page.waitForLoadState('networkidle');
    const body = await page.locator('body').innerText();
    const links = await page.locator('a[href]').evaluateAll(nodes => nodes.map(node => node.href));
    const checks = {
      http200: response?.status() === 200,
      heading: await page.locator('h1').count() === 1,
      noBrowserErrors: errors.length === 0,
      legacyGuessWithheld: !product.legacyGuessPresent || body.includes('개발 AI 미확인'),
      observationsVisible: (product.observations ?? []).every(fact => links.includes(fact.sourceUrl)),
      executionNotClaimed: !(product.observations?.length) || body.includes('실제 실행 모델이나 전체 제작 과정을 증명하지 않습니다'),
      unknownRelationVisible: product.relationship !== 'unknown' || !product.observations?.length || body.includes('제품과 저장소 관계 미확인'),
      fitsDesktop: await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    };
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    checks.fitsMobile = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    if (product.slug.startsWith('tradinggoose-')) await page.screenshot({ path: '/private/tmp/nomorevibe-tradinggoose-agent-mobile.png', fullPage: true });
    results.push({ slug: product.slug, passed: Object.values(checks).every(Boolean), checks, errors,
      observedFacts: product.observations?.length ?? 0, dataIssues: product.issues ?? [], scanState: product.scan?.state ?? 'unavailable' });
    await writeFile(output, JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2) + '\n');
    console.log(JSON.stringify(results.at(-1)));
    await page.close();
  }
} finally { await browser.close(); }
assert.ok(results.every(result => result.passed), 'live browser checks failed; inspect output');
