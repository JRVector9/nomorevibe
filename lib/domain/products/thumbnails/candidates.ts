import { decodeEntities } from '@/lib/net/normalize';
export type SiteImageHints={ogImage:string|null;icons:{url:string;size:number;apple:boolean}[];manifest:string|null};
function attributes(tag:string){const out:Record<string,string>={};for(const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))out[m[1].toLowerCase()]=decodeEntities(m[2]??m[3]??m[4]);return out;}
export function imageUrl(value:unknown,base:string):string|null{
 if(typeof value!=='string'||value.length>2000)return null;
 try{const u=new URL(value.trim(),base);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}
}
const size=(value:string|undefined)=>Math.max(0,...(value??'').split(/\s+/).map(s=>Number(s.split('x')[0])||0));
export function siteHints(html:string,base:string):SiteImageHints{
 const icons:SiteImageHints['icons']=[];let manifest:string|null=null,ogImage:string|null=null;
 for(const tag of html.match(/<(?:link|meta)\b[^>]*>/gi)??[]){const a=attributes(tag);
  if(a.property==='og:image')ogImage??=imageUrl(a.content,base);
  const rel=(a.rel??'').toLowerCase().split(/\s+/);const url=imageUrl(a.href,base);if(!url)continue;
  if(rel.includes('manifest'))manifest??=url;
  if(rel.includes('icon')||rel.includes('apple-touch-icon')||rel.includes('apple-touch-icon-precomposed'))icons.push({url,size:size(a.sizes),apple:rel.some(s=>s.startsWith('apple-touch'))});
 }
 return {ogImage,manifest,icons:icons.sort((a,b)=>Number(b.apple)-Number(a.apple)||b.size-a.size).filter((x,i,a)=>a.findIndex(y=>x.url===y.url)===i).slice(0,6)};
}
export function manifestIcons(value:unknown,base:string):string[]{
 if(!value||typeof value!=='object'||!('icons'in value)||!Array.isArray(value.icons))return [];
 return value.icons.filter((v):v is Record<string,string>=>!!v&&typeof v==='object'&&typeof v.src==='string').map(v=>({url:imageUrl(v.src,base),size:size(v.sizes)})).filter(v=>v.url).sort((a,b)=>b.size-a.size).slice(0,3).map(v=>v.url!);
}
export function repositoryImages(markdown:string,repo:string,branch:string,site:string):string[]{
 const entries:{alt:string;src:string}[]=[];
 for(const m of markdown.matchAll(/!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^\n]*?["'])?\s*\)/g))entries.push({alt:m[1],src:m[2]});
 for(const tag of markdown.match(/<img\b[^>]*>/gi)??[]){const a=attributes(tag);if(a.src)entries.push({alt:a.alt??'',src:a.src});}
 const base=`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/`;let siteHost='';try{siteHost=new URL(site).hostname;}catch{/* invalid site */}
 return entries.filter(({alt,src})=>/logo|banner|screenshot|preview|demo|screen|og[-_.]|social[-_](?:card|preview)|로고|화면/i.test(alt+' '+src)&&!/badge|shields\.io|sponsor|donat|workflow|actions\/|coverage|codecov|discord|buymeacoffee|stargazer|star-history/i.test(alt+' '+src)
  &&!/^(?:react|next\.?js|typescript|javascript|python|docker|node\.?js|vite|tailwind(?:css)?)(?:\s+(?:logo|icon))?$/i.test(alt.trim())).map(({src})=>{
  const normalized=src.replace(new RegExp(`^https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/blob/`),'https://raw.githubusercontent.com/'+repo+'/');
  const url=imageUrl(normalized,base);if(!url)return null;const u=new URL(url);
  return (u.hostname===siteHost||u.hostname==='raw.githubusercontent.com'&&u.pathname.toLowerCase().startsWith('/'+repo.toLowerCase()+'/')||u.hostname==='user-images.githubusercontent.com'||u.hostname==='github.com'&&u.pathname.startsWith('/user-attachments/assets/'))?url:null;
 }).filter((v):v is string=>!!v).filter((v,i,a)=>a.indexOf(v)===i).slice(0,3);
}
