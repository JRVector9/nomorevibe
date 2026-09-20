import{it,expect}from'vitest';import sharp from'sharp';import{resolveThumbnail}from'@/lib/domain/products/thumbnails/resolver';
it('never uses GitHub platform icons as an installable project thumbnail', async () => {
 const seen:string[]=[];
 await resolveThumbnail({name:'Plugin',url:'https://github.com/acme/plugin',repoUrl:'https://github.com/acme/plugin',accessMode:'installable'}, {request:async url=>{seen.push(url);return {ok:false,reason:'http',status:404};}});
 expect(seen).not.toContain('https://github.com/acme/plugin');
 expect(seen).not.toContain('https://github.com/favicon.ico');
 expect(seen).toContain('https://github.com/acme.png?size=256');
});
it('prefers app icons over repository and avatar and uses a default when every source fails',async()=>{
 const png=await sharp({create:{width:64,height:64,channels:4,background:'#123456'}}).png().toBuffer();const seen:string[]=[];
 const input={name:'Demo',url:'https://demo.example',repoUrl:'https://github.com/acme/demo'};
 const image=await resolveThumbnail(input,{request:async(url)=>{seen.push(url);return {ok:true,status:200,finalUrl:url,headers:new Headers(),body:url===input.url?Buffer.from('<link rel="apple-touch-icon" href="/apple.png">'):png};}});
 expect(image.kind).toBe('site_icon');expect(image.sourceUrl).toBe('https://demo.example/apple.png');expect(seen.some(s=>s.includes('github.com'))).toBe(false);
 expect((await resolveThumbnail(input,{request:async()=>({ok:false,reason:'http',status:404})})).kind).toBe('default');
});
it('falls through missing icons and README images to the exact GitHub owner avatar',async()=>{
 const png=await sharp({create:{width:64,height:64,channels:4,background:'#123456'}}).png().toBuffer();
 const result=await resolveThumbnail({name:'Demo',url:'https://demo.example',repoUrl:'https://github.com/acme/demo'},{request:async(url)=>url==='https://github.com/acme.png?size=256'?{ok:true,status:200,finalUrl:'https://avatars.githubusercontent.com/u/123',headers:new Headers(),body:png}:{ok:false,reason:'http',status:404}});
 expect(result.kind).toBe('github_avatar');
});
