import{test,expect}from'@playwright/test';import sharp from'sharp';import{inArray}from'drizzle-orm';import{db}from'@/lib/db';import{products,ogImages}from'@/lib/db/schema';
const kinds=['og','site_icon','repository_image','github_avatar','default'] as const;
const labels=['공개 페이지 대표 이미지','프로젝트 아이콘','GitHub 저장소 이미지','GitHub 프로필 이미지','nomorevibe 기본 이미지'];
test.beforeAll(async()=>{
 const slugs=kinds.map(k=>'thumbnail-e2e-'+k.replaceAll('_','-'));await db.delete(ogImages).where(inArray(ogImages.slug,slugs));await db.delete(products).where(inArray(products.slug,slugs));
 for(const[k,kind]of kinds.entries()){const slug=slugs[k],size=kind==='site_icon'?32:256;const image=await sharp({create:{width:size,height:size,channels:4,background:'#345678'}}).webp().toBuffer();
  await db.insert(products).values({slug,name:'Thumbnail '+kind,tagline:'A thumbnail test product',description:'A test description',category:'Dev',status:'seeded',source:'crawler',url:'https://'+slug+'.example.com',verifyToken:'test',editTokenHash:'test',ogImage:`/api/og-cache/${slug}?thumbnail=${kind}&w=${size}&h=${size}&v=1`});await db.insert(ogImages).values({slug,contentType:'image/webp',data:image});
 }
});
test('source labels and small icons render on desktop and mobile',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 for(const width of[1440,390]){await page.setViewportSize({width,height:900});for(const[k,kind]of kinds.entries()){
  await page.goto('/p/thumbnail-e2e-'+kind.replaceAll('_','-'));const root=page.getByTestId('product-hero-media');await expect(root).toContainText(labels[k]);const image=root.locator('img');await expect(image).toBeVisible();
  expect(await image.evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth>0)).toBe(true);
  if(kind==='repository_image')expect((await image.boundingBox())!.width).toBeLessThanOrEqual(112);
  if(kind==='site_icon')expect((await image.boundingBox())!.width).toBeLessThanOrEqual(32);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(kind==='site_icon'||kind==='default')await root.screenshot({path:`/tmp/nomorevibe-thumbnail-${kind}-${width}.png`});
 }}expect(errors).toEqual([]);
});
