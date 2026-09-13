import {fetchCapped,type CappedFetchResult}from'@/lib/net/fetch';
import{githubOwnerFromRepositoryUrl}from'@/lib/domain/products/github-owner';
import{siteHints,manifestIcons,repositoryImages,imageUrl,type SiteImageHints}from'./candidates';
import{normalizeThumbnail,defaultThumbnail,type ThumbnailImage}from'./images';
export type ThumbnailKind='og'|'site_icon'|'repository_image'|'github_avatar'|'default';
export const THUMBNAIL_RANK:Record<ThumbnailKind,number>={og:0,site_icon:1,repository_image:2,github_avatar:3,default:4};
export type ThumbnailInput={name:string;url:string;repoUrl:string|null;pageMeta?:Record<string,unknown>|null;repoMeta?:Record<string,unknown>|null};
export type ThumbnailResult=ThumbnailImage&{kind:ThumbnailKind;sourceUrl:string|null;errors:string[]};
type Request=(url:string,options:{maxBytes:number;timeoutMs:number;signal:AbortSignal})=>Promise<CappedFetchResult>;
export async function resolveThumbnail(input:ThumbnailInput,options:{request?:Request;signal?:AbortSignal}={}):Promise<ThumbnailResult>{
 const request=options.request??fetchCapped,total=Date.now()+28_000;let stage=total;const errors:string[]=[];const tried=new Set<string>();
 const get=async(url:string,maxBytes:number)=>{
  const remaining=Math.min(stage,total)-Date.now();if(remaining<=0||options.signal?.aborted)return null;
  try{const signal=AbortSignal.timeout(Math.max(1,Math.min(remaining,3000)));const r=await request(url,{maxBytes,timeoutMs:3000,signal:options.signal?AbortSignal.any([signal,options.signal]):signal});if(!r.ok){if(errors.length<12)errors.push(r.reason);return null;}return r;}catch{if(errors.length<12)errors.push('fetch_error');return null;}
 };
 const tryImage=async(url:string|null,kind:ThumbnailKind):Promise<ThumbnailResult|null>=>{
  if(!url||tried.has(url))return null;tried.add(url);const r=await get(url,5*1024*1024);if(!r)return null;
  try{return {...await normalizeThumbnail(r.body),kind,sourceUrl:r.finalUrl,errors};}catch{if(errors.length<12)errors.push('invalid_image');return null;}
 };
 stage=Math.min(total-14_000,Date.now()+7000);
 const savedOg=imageUrl(input.pageMeta?.ogImage,input.url);const saved=await tryImage(savedOg,'og');if(saved)return saved;
 const page=await get(input.url,512*1024);let hints:SiteImageHints={icons:[],manifest:null,ogImage:null};let pageUrl=input.url;
 if(page){pageUrl=page.finalUrl;hints=siteHints(page.body.toString('utf8'),pageUrl);const og=await tryImage(hints.ogImage,'og');if(og)return og;}
 else if(input.pageMeta?.thumbnailHints&&typeof input.pageMeta.thumbnailHints==='object'){
  const raw=input.pageMeta.thumbnailHints as Partial<SiteImageHints>;hints={ogImage:null,manifest:imageUrl(raw.manifest,input.url),icons:Array.isArray(raw.icons)?raw.icons.slice(0,6).flatMap(v=>{const url=imageUrl(v?.url,input.url);return url?[{url,size:Number(v.size)||0,apple:!!v.apple}]:[]}):[]};
 }
 stage=Math.min(total-9000,Date.now()+10_000);
 let appIcons:string[]=[];if(hints.manifest){const m=await get(hints.manifest,64*1024);if(m)try{appIcons=manifestIcons(JSON.parse(m.body.toString('utf8')),m.finalUrl);}catch{errors.push('invalid_manifest');}}
 const icons=[...appIcons,...hints.icons.map(i=>i.url),new URL('/apple-touch-icon.png',pageUrl).href,new URL('/favicon.ico',pageUrl).href];
 for(const url of [...new Set(icons)].slice(0,7)){const image=await tryImage(url,'site_icon');if(image)return image;}
 stage=Math.min(total-3500,Date.now()+6500);
 const owner=githubOwnerFromRepositoryUrl(input.repoUrl),repo=owner?.repositoryUrl.slice('https://github.com/'.length);
 if(repo){const branch=typeof input.repoMeta?.default_branch==='string'?input.repoMeta.default_branch:'HEAD';
  for(const name of ['README.md','readme.md']){
   const r=await get(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${name}`,256*1024);if(!r)continue;
   for(const url of repositoryImages(r.body.toString('utf8'),repo,branch,input.url)){const image=await tryImage(url,'repository_image');if(image)return image;}break;
  }
 }
 stage=total;
 if(owner){
  // Derive from the normalized GitHub owner, never an unrelated avatar URL in arbitrary metadata.
  const image=await tryImage(`https://github.com/${owner.login}.png?size=256`,'github_avatar');if(image)return image;
 }
 return {...await defaultThumbnail(input.name),kind:'default',sourceUrl:null,errors};
}
