import{describe,it,expect}from'vitest';
import{siteHints,manifestIcons,repositoryImages}from'@/lib/domain/products/thumbnails/candidates';
describe('thumbnail candidates',()=>{
 it('orders apple touch above sized favicons and resolves quoted relative paths',()=>{
  const h=siteHints(`<link rel="icon" href="/small.ico" sizes="16x16"><link href='/touch.png' rel='apple-touch-icon'><link rel="icon" href="large.png" sizes="192x192"><link rel="manifest" href="/app.webmanifest"><meta property="og:image" content="/Bob's image.png">`,'https://demo.test/nested/');
  expect(h.icons.map(i=>i.url)).toEqual(['https://demo.test/touch.png','https://demo.test/nested/large.png','https://demo.test/small.ico']);
  expect(h.manifest).toBe('https://demo.test/app.webmanifest');expect(h.ogImage).toContain("Bob's%20image.png");
 });
 it('ranks manifest icons and rejects unsafe schemes',()=>{
  expect(manifestIcons({icons:[{src:'small.png',sizes:'32x32'},{src:'/large.png',sizes:'512x512'},{src:'data:image/svg+xml,abc',sizes:'1024x1024'}]},'https://demo.test/a/manifest.json')).toEqual(['https://demo.test/large.png','https://demo.test/a/small.png']);
 });
 it('uses relevant repo images and excludes badges, sponsors and unrelated hosts',()=>{
  const md='![build](https://img.shields.io/a)\n![sponsor](sponsor.png)\n![Project logo](docs/logo.svg)\n<img alt="App screenshot" src="./docs/screen.png">\n![logo](https://unrelated.test/logo.png)\n![React logo](docs/react-logo.svg)';
  expect(repositoryImages(md,'acme/app','main','https://demo.test')).toEqual(['https://raw.githubusercontent.com/acme/app/main/docs/logo.svg','https://raw.githubusercontent.com/acme/app/main/docs/screen.png']);
 });
});
