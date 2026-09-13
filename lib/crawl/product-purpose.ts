export type ProductPurposeInput={title?:string|null;description?:string|null;textSample?:string|null};
export type NonProductPurpose={kind:'research_document'|'one_off_survey';evidence:string};
/** Judge the page's stated purpose, never a bare research/survey keyword. */
export function nonProductPurpose(input:ProductPurposeInput):NonProductPurpose|null{
 const title=(input.title??'').slice(0,500).toLowerCase();
 const identity=[title,(input.description??'').slice(0,1200)].join(' ').toLowerCase();
 const body=(input.textSample??'').slice(0,6000).toLowerCase();
 const reusableResearch=/\bresearch\s+(?:survey|papers?|notes?|journal|publications)\s+(?:dashboard|search|engine|manager|builder|platform|software|tool|app)\b/.test(identity);
 const tool=/\b(?:survey|questionnaire|form|research|notebook|reference)\s+(?:builder|platform|software|tool|assistant|manager|app|engine)\b|\b(?:management|survey) platform\b|\breusable\b.{0,60}\b(?:app|tool|notebook)\b|(?:설문|연구|폼).{0,12}(?:제작 도구|제작 플랫폼|관리 도구|관리 앱)/i.test(identity);
 if(tool||reusableResearch)return null;
 const survey=identity.match(/(?:학위\s*논문|석사\s*(?:학위|연구)|박사\s*학위|연구|실험).{0,50}설문|(?:research|academic|participant|customer satisfaction|thesis|dissertation)\s+(?:\w+\s+){0,3}(?:survey|questionnaire)\b|\b(?:survey|questionnaire)\s+for\s+(?:my|our|a)\s+(?:research|thesis|study)/i);
 if(survey)return {kind:'one_off_survey',evidence:survey[0]};
 if(/(?:연구 참여에 동의|연구 설문에 참여|학문적 연구 이외의 목적으로)/.test(body)&&/설문|응답/.test(body))return {kind:'one_off_survey',evidence:'연구 참여 동의·설문 응답 페이지'};
 if(/\b(?:survey|questionnaire)\b/.test(identity)&&/participation is voluntary|consent to participate/.test(body)&&/research|study/.test(body))return {kind:'one_off_survey',evidence:'research participant consent'};
 const personal=identity.match(/\b(?:personal|my)\b.{0,60}\bresearch\b.{0,30}\b(?:journal|notes|notebook|diary)\b|개인.{0,15}연구.{0,15}(?:문서|노트|일지|기록)/i);
 if(personal)return {kind:'research_document',evidence:personal[0]};
 const publication=title.match(/\bresearch\s+(?:publications|papers|notes|journal)\b|(?:논문|연구).{0,10}(?:요약|정리|문서|노트|일지)$/i);
 if(publication)return {kind:'research_document',evidence:publication[0]};
 return null;
}
