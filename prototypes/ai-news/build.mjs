import {readFile,writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=new URL('./',import.meta.url);
export async function build(){
 const data=JSON.parse(await readFile(new URL('data.json',root),'utf8'));
 const template=await readFile(new URL('template.html',root),'utf8');
 // Feed text cannot terminate the inert JSON script element.
 const snapshot=JSON.stringify(data).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
 await writeFile(new URL('index.html.tmp',root),template.replace('__SNAPSHOT__',()=>snapshot));
 await rename(new URL('index.html.tmp',root),new URL('index.html',root));
 return {articles:data.articles.length,companies:new Set(data.articles.map(a=>a.company)).size};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(await build());
