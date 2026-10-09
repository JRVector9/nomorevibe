import{BRAND}from'@/lib/copy/brand';import{PREVIEW_IMAGE_LABEL}from'@/lib/copy/terms';
const LABELS:Record<string,string>={og:PREVIEW_IMAGE_LABEL,site_icon:'프로젝트 아이콘',repository_image:'GitHub 저장소 이미지',github_avatar:'GitHub 프로필 이미지',default:`${BRAND} 기본 이미지`};
export function thumbnailPresentation(src:string|null|undefined){
 let kind='og',width=1200,height=630;
 if(src?.startsWith('/api/og-cache/'))try{const u=new URL(src,'https://nomorevibe.invalid');const k=u.searchParams.get('thumbnail');if(k&&Object.hasOwn(LABELS,k)){kind=k;width=Math.max(16,Math.min(1200,Number(u.searchParams.get('w'))||96));height=Math.max(16,Math.min(630,Number(u.searchParams.get('h'))||96));}}catch{/* legacy image */}
 const identity=['site_icon','github_avatar','default'].includes(kind)||(kind==='repository_image'&&(Math.max(width,height)<=256||(width/height>=0.85&&width/height<=1.18)));
 // 정사각 아이콘 자리에 둘 수 있는 것 — 사이트 아이콘과 GitHub 프로필 그림뿐이다(UX-32). README 그림·대표 이미지는 잘라 넣지 않는다
 const icon=kind==='site_icon'||kind==='github_avatar';
 // README assets can be wide wordmarks as well as screenshots; preserve the whole image.
 return {kind,label:LABELS[kind],identity,icon,contain:identity||kind==='repository_image',width,height};
}
