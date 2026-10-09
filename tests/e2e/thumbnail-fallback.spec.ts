import{test,expect}from'@playwright/test';import sharp from'sharp';import{inArray}from'drizzle-orm';import{db}from'@/lib/db';import{products,ogImages}from'@/lib/db/schema';
const kinds=['og','site_icon','repository_image','github_avatar','default'] as const;
const labels=['사이트 미리보기 이미지','프로젝트 아이콘','GitHub 저장소 이미지','GitHub 프로필 이미지','nomorevibe 기본 이미지'];
test.beforeAll(async()=>{
 const slugs=kinds.map(k=>'thumbnail-e2e-'+k.replaceAll('_','-'));await db.delete(ogImages).where(inArray(ogImages.slug,slugs));await db.delete(products).where(inArray(products.slug,slugs));
 for(const[k,kind]of kinds.entries()){const slug=slugs[k],size=kind==='site_icon'?32:256;const image=await sharp({create:{width:size,height:size,channels:4,background:'#345678'}}).webp().toBuffer();
  await db.insert(products).values({slug,name:'Thumbnail '+kind,tagline:'A thumbnail test product',description:'A test description',category:'Dev',status:'seeded',source:'crawler',url:'https://'+slug+'.example.com',verifyToken:'test',editTokenHash:'test',ogImage:`/api/og-cache/${slug}?thumbnail=${kind}&w=${size}&h=${size}&v=1`});await db.insert(ogImages).values({slug,contentType:'image/webp',data:image});
 }
});
test('hero icons and source-labelled previews render on desktop and mobile',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 for(const width of[1440,390]){await page.setViewportSize({width,height:900});for(const[k,kind]of kinds.entries()){
  await page.goto('/p/thumbnail-e2e-'+kind.replaceAll('_','-'));
  // v5 히어로는 큰 이미지 없이 80px 아이콘 하나 — 출처 이름은 아이콘이 아닌 이미지의 미리보기에만 붙는다
  // 아이콘 자리에는 사이트 아이콘·GitHub 프로필만 — 나머지는 이름 첫 글자 모노그램이다(UX-32)
  const hero=page.locator('main section').first(),iconKind=kind==='site_icon'||kind==='github_avatar';
  const icon=iconKind?page.getByRole('img',{name:'Thumbnail '+kind,exact:true}):hero.locator('.product-monogram');
  await expect(icon).toBeVisible();
  if(iconKind)expect(await icon.evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth>0)).toBe(true);
  else await expect(hero.locator('img')).toHaveCount(0);
  expect((await icon.boundingBox())!.width).toBeLessThanOrEqual(80);
  const preview=page.locator('figure').filter({hasText:labels[k]});
  if(kind==='og'){const image=preview.locator('img');await image.scrollIntoViewIfNeeded();await expect(image).toBeVisible();
   await expect.poll(()=>image.evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth>0)).toBe(true);}
  else await expect(preview).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(kind==='site_icon'||kind==='default')await icon.screenshot({path:`/tmp/nomorevibe-thumbnail-${kind}-${width}.png`});
 }}expect(errors).toEqual([]);
});
test('wide repository wordmarks stay whole in covers and never in the icon square',async({page})=>{
 const{execFileSync}=await import('node:child_process');
 const data=await sharp({create:{width:512,height:128,channels:4,background:'#345678'}}).webp().toBuffer();
 await db.update(ogImages).set({data}).where(inArray(ogImages.slug,['thumbnail-e2e-repository-image']));
 const ogImage='/api/og-cache/thumbnail-e2e-repository-image?thumbnail=repository_image&w=512&h=128&v=2';
 await page.goto('/');
 // 실제 React 마크업으로 커버와 아이콘의 원본 비율을 확인한다.
 const html=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
  import React from 'react';import{renderToStaticMarkup}from'react-dom/server';globalThis.React=React;
  const{ProjectTile}=await import('./components/home/ProjectTile.tsx');const{ProductIcon}=await import('./components/ProductIcon.tsx');
  const ogImage=${JSON.stringify(ogImage)};
  console.log(renderToStaticMarkup(React.createElement('div',{id:'wide-logo-check',style:{width:360}},React.createElement(ProjectTile,{slug:'wide-logo',name:'Wide logo',ogImage,size:64}),React.createElement(ProductIcon,{name:'Wide logo',ogImage,size:48}))));
 `],{encoding:'utf8'});

 await page.evaluate(html=>{const host=document.createElement('div');host.innerHTML=html;document.body.prepend(host)},html);
 // README 그림은 커버에만 — 정사각 아이콘 자리에는 모노그램(UX-32). 커버는 늘리지 않고 잘리지 않게(scale-down)
 const images=page.locator('#wide-logo-check img');await expect(images).toHaveCount(1);
 const cover=images.first();await expect(cover).toBeVisible();
 await expect.poll(()=>cover.evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth===512)).toBe(true);
 expect(await cover.evaluate(e=>getComputedStyle(e).objectFit)).toBe('scale-down');
 expect((await cover.boundingBox())!.width).toBe(360);
 const monogram=page.locator('#wide-logo-check > .product-monogram');await expect(monogram).toHaveText('W');
 expect((await monogram.boundingBox())!.width).toBe(48);
 await page.locator('#wide-logo-check').screenshot({path:'/tmp/nomorevibe-thumbnail-wide-logo.png'});
});

test('public-page representative images fill home thumbnails without changing the grid',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto('/?sort=recent&q=Thumbnail+og');
 const card=page.locator('.project-card').filter({hasText:'Thumbnail og'});
 const image=card.locator('.project-tile img');
 await expect(image).toHaveAttribute('src',/thumbnail=og/);
 await expect.poll(()=>image.evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth>0)).toBe(true);
 await expect(card).toBeVisible();
 await expect.poll(async()=>{
  const cardBox=await card.boundingBox(),imageBox=await image.boundingBox();
  return cardBox&&imageBox?imageBox.width/cardBox.width:0;
 }).toBeGreaterThan(0.9);
 const imageBox=await image.boundingBox();
 expect(imageBox!.height).toBeGreaterThan(150);
 expect(await image.evaluate(e=>getComputedStyle(e).objectFit)).toBe('contain');
 expect(await page.locator('.projects-grid').evaluate(e=>getComputedStyle(e).display)).toBe('grid');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
