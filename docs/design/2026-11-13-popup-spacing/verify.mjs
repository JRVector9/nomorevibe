import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
const browser=await chromium.launch({headless:true});
const page=await browser.newPage();
const records=[];page.on('pageerror',e=>console.error('PAGE ERROR',e));
const url=pathToFileURL(process.cwd()+'/docs/design/2026-11-13-popup-spacing/preview.html').href;
for(const [name,width,height] of [['reference',699,1161],['desktop',1440,1000],['mobile',390,844],['narrow',320,568],['landscape',844,390]]){
 console.log('checking',name);await page.setViewportSize({width,height});await page.goto(url+'?v='+Math.random());await page.locator('#open-job').click();
 await page.locator('dialog').waitFor({state:'visible'});
 const dimensions=await page.locator('dialog').evaluate(d=>{const c=d.querySelector('.ops-modal-content'),h=d.querySelector('h2'),p=d.querySelector('p');return {width:d.clientWidth,height:d.clientHeight,scrollWidth:d.scrollWidth,scrollHeight:d.scrollHeight,inset:h.getBoundingClientRect().left-d.getBoundingClientRect().left,padding:getComputedStyle(c).padding,lineHeight:getComputedStyle(p).lineHeight,fontSize:getComputedStyle(p).fontSize,columns:getComputedStyle(d.querySelector('.ops-facts')).gridTemplateColumns};});
 if(dimensions.scrollWidth>dimensions.width||dimensions.inset<16||dimensions.height>height-30)throw Error(name+JSON.stringify(dimensions));
 await page.screenshot({path:`docs/design/2026-11-13-popup-spacing/${name}.png`});
 await page.locator('dialog').evaluate(d=>{d.scrollTop=d.scrollHeight;});
 if(!await page.getByRole('button',{name:'이 작업 멈춤',exact:true}).isVisible())throw Error('Missing final action');
 await page.locator('dialog').evaluate(d=>{d.scrollTop=0;});
 await page.locator('h2#job-title').click();if(!await page.locator('dialog').isVisible())throw Error('inner click closed dialog');
 await page.keyboard.press('Escape');await page.locator('dialog').waitFor({state:'detached'});
 if(!await page.locator('#open-job').evaluate(e=>e===document.activeElement))throw Error('focus not returned');
 await page.locator('#open-job').click();await page.getByRole('button',{name:'닫기',exact:true}).click();await page.locator('dialog').waitFor({state:'detached'});
 await page.locator('#open-job').click();await page.mouse.click(2,2);await page.locator('dialog').waitFor({state:'detached'});
 records.push({name,viewport:{width,height},...dimensions,escape:true,focusReturn:true,close:true,backdrop:true,innerClick:true});
}
await page.setViewportSize({width:1440,height:1000});await page.goto(url+'?v='+Math.random());await page.locator('#open-worker').click();await page.screenshot({path:'docs/design/2026-11-13-popup-spacing/worker.png'});
await page.keyboard.press('Escape');
await page.evaluate(()=>document.documentElement.dataset.adminTheme='dark');await page.locator('#open-job').click();await page.screenshot({path:'docs/design/2026-11-13-popup-spacing/dark.png'});
fs.writeFileSync('docs/design/2026-11-13-popup-spacing/browser-checks.json',JSON.stringify(records,null,2));
console.log(JSON.stringify(records,null,2));await browser.close();
