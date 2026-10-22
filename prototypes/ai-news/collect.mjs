/** Local design prototype only. Fixed official feeds, no database or credentials. */
import {readFile,writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {build} from './build.mjs';
const root=new URL('./',import.meta.url);
const parser=new XMLParser({ignoreAttributes:false,processEntities:true,htmlEntities:true});
const list=x=>Array.isArray(x)?x:x?[x]:[];
const text=x=>typeof x==='string'?x:typeof x?.['#text']==='string'?x['#text']:'';
const clean=x=>text(x).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const canonical=u=>u.replace(/\/$/,'');
function https(u){try{const parsed=new URL(u);return parsed.protocol==='https:'?parsed.href:null}catch{return null}}
async function fetchFeed(url){
 const response=await fetch(url,{signal:AbortSignal.timeout(15000),headers:{'User-Agent':'nomorevibe-news-design-preview/1.0'}});
 if(!response.ok)throw Error('HTTP '+response.status);
 const reader=response.body.getReader();let bytes=0;const chunks=[];
 while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2*1024*1024){await reader.cancel();throw Error('Feed exceeds 2MB')}chunks.push(value)}
 const xml=Buffer.concat(chunks).toString('utf8');if(XMLValidator.validate(xml)!==true)throw Error('Invalid XML');
 const parsed=parser.parse(xml),entries=parsed.rss?.channel?.item??parsed.feed?.entry;
 if(!entries)throw Error('No feed entries');return list(entries);
}
function itemUrl(i){return https(typeof i.link==='string'?i.link:list(i.link).find(l=>l['@_rel']==='alternate')?.['@_href']||list(i.link)[0]?.['@_href'])}
function date(i,now){const raw=text(i.pubDate||i.published||i.updated),d=new Date(raw);return Number.isFinite(d.getTime())&&d<=now?d.toISOString():null}
let inFlight;
export function collect(){if(!inFlight)inFlight=run().finally(()=>{inFlight=null});return inFlight}
async function run(){
 const [sources,editorial,old,images]=await Promise.all(['sources.json','editorial.json','data.json','image-cache.json'].map(async file=>JSON.parse(await readFile(new URL(file,root),'utf8'))));
 const now=new Date(),checkedAt=now.toISOString(),sourceStatus=[];
 const articles=new Map(old.articles.map(a=>[canonical(a.url),a]));
 const curated=new Map(editorial.articles.map(a=>[canonical(a.url),a]));
 await Promise.all(sources.map(async source=>{
  try{const items=await fetchFeed(source.url);let count=0;
   for(const i of items.slice(0,source.name==='OpenAI'?5:3)){
    const url=itemUrl(i),publishedAt=date(i,now),originalTitle=clean(i.title).slice(0,300);
    if(!url||!publishedAt||!originalTitle)continue;
    // General vendor feeds can include unrelated gaming and community posts.
    if(source.name==='NVIDIA'&&!/\b(ai|robot|nvlink|inference|blackwell|cuda)\b/i.test(originalTitle))continue;
    if(source.name==='Hugging Face'&&!/^\/blog\/[^/]+\/?$/.test(new URL(url).pathname))continue;
    const key=canonical(url),custom=curated.get(key),previous=articles.get(key);
    const rawImage=list(i['media:content'])[0]?.['@_url']||i['media:thumbnail']?.['@_url'];
    const image=custom?.image||previous?.image||https(rawImage);
    articles.set(key,{id:custom?.id||previous?.id||key,title:custom?.title||originalTitle,originalTitle,summary:custom?.summary||'',topic:custom?.topic||(['Cursor','GitHub'].includes(source.name)?'개발':'기업·산업'),company:source.company,publisher:source.name,url,publishedAt,image,imageData:images[image]||previous?.imageData||null,sourceUrl:source.url,mode:'feed'});count++;
   }
   sourceStatus.push({...source,ok:true,count,checkedAt});
  }catch(error){sourceStatus.push({...source,ok:false,error:error.message,checkedAt})}
 }));
 let videos=old.videos;const videoUrl='https://www.youtube.com/feeds/videos.xml?channel_id=UCXZCJLdBC09xxGZ6gcdrc6A';
 try{const entries=await fetchFeed(videoUrl),first=entries.find(i=>date(i,now)&&/^[A-Za-z0-9_-]{11}$/.test(text(i['yt:videoId'])));if(!first)throw Error('No published video');const id=text(first['yt:videoId']),custom=editorial.videos.find(v=>v.id===id),image='https://i.ytimg.com/vi/'+id+'/hqdefault.jpg';videos=[{id,author:'OpenAI',originalTitle:clean(first.title),title:custom?.title||clean(first.title),date:date(first,now),mode:'feed',image,imageData:images[image]||null,url:'https://www.youtube.com/watch?v='+id},...editorial.videos.filter(v=>v.mode==='curated').map(v=>({...v,imageData:images[v.image]||null}))];sourceStatus.push({name:'OpenAI YouTube',url:videoUrl,ok:true,count:1,checkedAt})}catch(error){sourceStatus.push({name:'OpenAI YouTube',url:videoUrl,ok:false,error:error.message,checkedAt})}
 const data={...old,collectedAt:checkedAt,articles:[...articles.values()].sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt)).slice(0,500),videos,sourceStatus,sources};
 await writeFile(new URL('data.json.tmp',root),JSON.stringify(data,null,2));await rename(new URL('data.json.tmp',root),new URL('data.json',root));await build();
 return {checkedAt,articles:data.articles.length,sources:sourceStatus.map(s=>({name:s.name,ok:s.ok,count:s.count,error:s.error}))};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(await collect(),null,2));
