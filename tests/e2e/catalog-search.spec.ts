import{test,expect}from'@playwright/test';import{db}from'@/lib/db';import{products}from'@/lib/db/schema';import{ensureSchema,resetTables}from'../integration/setup';
test.beforeAll(async()=>{ensureSchema();await resetTables();for(let i=1;i<=12;i++){const num=String(i).padStart(2,'0');await db.insert(products).values({slug:`catalog-qa-${num}`,name:`Catalog Project ${num}`,url:`https://catalog-${num}.example`,tagline:'A useful app for teams',description:i===12?'A quantum experiment planner':'Plan daily work',repoUrl:`https://github.com/CatalogueOwner/repo-${num}`,category:'Dev',status:'seeded',source:'crawler',stars:2500,starsPrevious:i===2?2502:2495,starsAt:new Date(),starsPreviousAt:new Date(Date.now()-86400000),verifyToken:'v',editTokenHash:'e'});}});
test('global search reveals nine cards and matches owner, repository and description',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize({width:1440,height:1000});await page.goto('/?sort=all-time&category=Finance');
 const search=page.getByRole('searchbox',{name:'프로젝트 검색'});await search.fill('@CatalogueOwner');await search.press('Enter');await page.waitForURL(u=>u.searchParams.get('q')==='@CatalogueOwner');
 expect(new URL(page.url()).searchParams.has('category')).toBe(false);expect(new URL(page.url()).searchParams.has('sort')).toBe(false);
 await expect(page.getByRole('heading',{name:'“@CatalogueOwner” 검색 결과'})).toBeVisible();await expect(page.locator('.project-card')).toHaveCount(9);
 expect(await page.locator('#projects').evaluate(e=>e.getBoundingClientRect().top)).toBeLessThan(400);
 await expect(page.locator('#popular-projects')).toHaveCount(0);
 await page.getByRole('link',{name:/프로젝트 더 보기/}).click();await expect(page.locator('.project-card')).toHaveCount(12);
 await search.fill('quantum');await search.press('Enter');await page.waitForURL(/q=quantum/);await expect(page.locator('.project-card')).toHaveCount(1);await expect(page.locator('.project-title')).toHaveText('Catalog Project 12');
 await search.fill('CatalogueOwner/repo-02');await search.press('Enter');await page.waitForURL(u=>u.searchParams.get('q')==='CatalogueOwner/repo-02');await expect(page.locator('.star-change-down')).toHaveText('−2');
 await page.setViewportSize({width:390,height:844});await search.fill('@CatalogueOwner');await search.press('Enter');await page.waitForURL(u=>u.searchParams.get('q')==='@CatalogueOwner');await expect(page.locator('.project-card')).toHaveCount(9);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'/tmp/nomorevibe-catalog-search-mobile.png'});expect(errors).toEqual([]);
});
