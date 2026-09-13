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
test('wide repository wordmarks remain fully visible in covers and icons',async({page})=>{
 const{execFileSync}=await import('node:child_process');
 const data=await sharp({create:{width:512,height:128,channels:4,background:'#345678'}}).webp().toBuffer();
 await db.update(ogImages).set({data}).where(inArray(ogImages.slug,['thumbnail-e2e-repository-image']));
 const ogImage='/api/og-cache/thumbnail-e2e-repository-image?thumbnail=repository_image&w=512&h=128&v=2';
 await page.goto('/');
 // Render outside Playwright's component transform so the real React markup reaches the browser.
 const html=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
  import React from 'react';import{renderToStaticMarkup}from'react-dom/server';globalThis.React=React;
  const{ProjectCover}=await import('./components/home/ProjectCover.tsx');const{ProductIcon}=await import('./components/ProductIcon.tsx');
  const ogImage=${JSON.stringify(ogImage)};
  console.log(renderToStaticMarkup(React.createElement('div',{id:'wide-logo-check',style:{width:360}},React.createElement(ProjectCover,{name:'Wide logo',ogImage,art:'paper'}),React.createElement(ProductIcon,{name:'Wide logo',ogImage,size:48}))));
 `],{encoding:'utf8'});

 await page.evaluate(html=>{const host=document.createElement('div');host.innerHTML=html;document.body.prepend(host)},html);
 const images=page.locator('#wide-logo-check img');await expect(images).toHaveCount(2);
 for(const img of await images.all()){await expect(img).toBeVisible();await expect.poll(()=>img.evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth===512)).toBe(true);expect(await img.evaluate(e=>getComputedStyle(e).objectFit)).toBe('contain');}
 expect((await images.first().boundingBox())!.height).toBeLessThanOrEqual(128);
 await page.locator('#wide-logo-check').screenshot({path:'/tmp/nomorevibe-thumbnail-wide-logo.png'});
});
