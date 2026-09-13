const LABELS:Record<string,string>={og:'공개 페이지 대표 이미지',site_icon:'프로젝트 아이콘',repository_image:'GitHub 저장소 이미지',github_avatar:'GitHub 프로필 이미지',default:'nomorevibe 기본 이미지'};
export function thumbnailPresentation(src:string|null|undefined){
 let kind='og',width=1200,height=630;
 if(src?.startsWith('/api/og-cache/'))try{const u=new URL(src,'https://nomorevibe.invalid');const k=u.searchParams.get('thumbnail');if(k&&Object.hasOwn(LABELS,k)){kind=k;width=Math.max(16,Math.min(1200,Number(u.searchParams.get('w'))||96));height=Math.max(16,Math.min(630,Number(u.searchParams.get('h'))||96));}}catch{/* legacy image */}
 const identity=['site_icon','github_avatar','default'].includes(kind)||(kind==='repository_image'&&(Math.max(width,height)<=256||(width/height>=0.85&&width/height<=1.18)));
 // README assets can be wide wordmarks as well as screenshots; preserve the whole image.
 return {kind,label:LABELS[kind],identity,contain:identity||kind==='repository_image',width,height};
}
