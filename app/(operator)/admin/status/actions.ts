'use server';
import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { agentRequest } from '@/lib/operations/agent-client';
import { requestAdminJob } from '@/lib/operations/admin';
import { setManualCategory } from '@/lib/operations/categories';
import { modelConfigSchema, type AgentStatus } from '@/lib/operations/contracts';
import { CATEGORIES, type Category } from '@/lib/domain/products/schema';
import { adminAuditRow, recordAdminAction } from '@/lib/operations/admin-log';
import { ACK_ACTION, ACK_DAYS, BACKLOG_KEYS, UNACK_ACTION } from '@/lib/operations/attention';
import { getSettings, saveSettings } from '@/lib/crawl/settings';
import { db } from '@/lib/db';
import { operationsAudit } from '@/lib/db/schema';
import { COLLECTION_OFF_REASONS, COLLECTION_ON_REASONS } from './collection-reasons';
export type ActionResult = { message?: string; error?: string; status?: AgentStatus };
export async function requestOperation(name:string):Promise<ActionResult> {
  const admin=await currentAdmin();if(!admin)return {error:'관리자 로그인이 필요합니다.'};
  try{const message=await requestAdminJob(name,admin.login);revalidatePath('/admin/status');return {message};}
  catch(error){await recordAdminAction(admin.login,{action:'request-job',target:name,ok:false,error:error instanceof Error?error.message:String(error)});return {error:'작업 요청을 처리하지 못했습니다.'};}
}
export async function codexOperation(action:string,data:Record<string,unknown>={}):Promise<ActionResult> {
  /**
   * 관리자 화면을 여는 사람이면 연결을 다시 맺을 수 있다(2026-10-07 운영자 결정) — 다른 관리자 작업과 같은 문.
   * 전에는 GitHub 로그인 세션을 따로 요구해, 로그인 없이 여는 운영 관리자(ADMIN_LOCAL_LOGIN)에서는 "다시 인증"이 늘 막혔다.
   * 관리자 화면이 열려 있는 동안은 누구나 Codex·Claude 계정을 바꿔 맺을 수 있으므로 관리자 화면 자체를 닫는 것(OAuth·Cloudflare Access)이 남은 일이다.
   */
  const admin=await currentAdmin();if(!admin)return {error:'관리자 로그인이 필요합니다.'};
  if(!['status','connect','input','cancel','probe','test','apply'].includes(action))return {error:'허용되지 않은 작업입니다.'};
  try {
    if(action==='test'||action==='apply')data={...data,config:modelConfigSchema.parse(data.config)};
    const status=await agentRequest<AgentStatus>(action,data);
    // data 는 남기지 않는다 — input 에는 인증 코드가 실린다
    if(action!=='status')await recordAdminAction(admin.login,{action:`ai-${action}`,target:'connect-agent',detail:{generation:status.generation,configVersion:status.configVersion}});
    if(action!=='status')revalidatePath('/admin/status');return {status};
  } catch(error) {
    const message=error instanceof Error?error.message:'AI 연결 서비스 요청 실패';
    if(action!=='status')await recordAdminAction(admin.login,{action:`ai-${action}`,target:'connect-agent',ok:false,error:message});
    return {error:message};
  }
}
export async function saveManualCategory(data:{repo:string;sourceHash:string;category:string;reason:string}):Promise<ActionResult> {
  const admin=await currentAdmin();if(!admin)return {error:'관리자 로그인이 필요합니다.'};
  if(!CATEGORIES.includes(data.category as Category))return {error:'카테고리를 선택해주세요.'};
  try {await setManualCategory({...data,category:data.category as Category,actor:admin.login});revalidatePath('/admin/status');return {message:'분류를 저장하고 발행 검토를 요청했습니다. 출처·심사·중복·차단 조건을 다시 확인한 뒤 발행합니다.'};}
  catch(error){
    const message=error instanceof Error?error.message:'분류 저장 실패';
    await recordAdminAction(admin.login,{action:'manual-category',target:data.repo,detail:{category:data.category,reason:data.reason},ok:false,error:message});
    return {error:message};
  }
}
/**
 * 수집 켜기·끄기 — 운영센터 머리의 즉시 스위치(2026-10-08 UX 감사 ADM-18). enabled 하나만 바꾼다.
 *
 * 설정 저장 경로(saveSettings)에 enabled 만 담아 보낸다 — 행 잠금 안에서 지금 값에 덧씌우므로 다른 값은 그대로다.
 * expectedFormVersion 은 주지 않는다: 이 스위치는 폼을 그린 판과 상관없이 지금 값을 바꾸는 것이고, 열려 있던 설정 폼은
 * 판이 바뀌어(settingsFormVersion 에 enabled 가 들어 있다) 다음 저장에서 "그 사이 바뀌었습니다"로 거절된다 — 꺼 둔 수집을 옛 폼이 되살리지 않는다.
 * saveSettings 가 남기는 settings-save 줄 옆에 사유를 담은 collection-enabled 줄을 하나 더 남긴다.
 */
export async function setCollectionEnabled(input:{enabled:boolean;reason:string;note?:string}):Promise<ActionResult> {
  const admin=await currentAdmin();if(!admin)return {error:'관리자 로그인이 필요합니다.'};
  const reasons:readonly {value:string}[]=input.enabled?COLLECTION_ON_REASONS:COLLECTION_OFF_REASONS;
  if(typeof input.enabled!=='boolean'||!reasons.some(r=>r.value===input.reason))return {error:'사유를 골라 주세요.'};
  const note=(input.note??'').trim().slice(0,500);
  if(input.reason==='other'&&!note)return {error:'기타 사유는 메모에 적어 주세요.'};
  const current=await getSettings();
  if(current.enabled===input.enabled)return {message:input.enabled?'이미 켜져 있습니다.':'이미 꺼져 있습니다.'};
  const result=await saveSettings({enabled:input.enabled},admin.login);
  await recordAdminAction(admin.login,{action:'collection-enabled',target:'crawl_settings',detail:{before:current.enabled,after:input.enabled,reason:input.reason,note},
    ok:result.ok,error:result.ok?null:result.issues.join(' · ')});
  if(!result.ok)return {error:result.issues.join(' · ')};
  revalidatePath('/admin/status');revalidatePath('/admin');
  return {message:input.enabled?'수집을 켰습니다 — 다음 예약부터 수집합니다.':'수집을 껐습니다 — 다음 예약부터 새 수집을 멈춥니다.'};
}
/**
 * 쌓인 일의 "확인함 · 7일 숨김"·"다시 보이기"(ADM-08) — 새 표 없이 작업 로그에 남기고, 화면은 항목마다 가장 최근 줄을 읽는다(attentionAcks).
 * 숨길 수 있는 것은 쌓인 일(BACKLOG_KEYS)뿐이다. 기록이 곧 상태라 실패를 삼키지 않는다.
 */
export async function acknowledgeAttention(input:{key:string;hide:boolean;count:number|string}):Promise<ActionResult> {
  const admin=await currentAdmin();if(!admin)return {error:'관리자 로그인이 필요합니다.'};
  if(!BACKLOG_KEYS.has(input.key))return {error:'숨길 수 있는 항목이 아닙니다.'};
  const count=typeof input.count==='number'||typeof input.count==='string'?input.count:null;
  try {
    await db.insert(operationsAudit).values(await adminAuditRow(admin.login,{action:input.hide?ACK_ACTION:UNACK_ACTION,target:input.key,
      detail:input.hide?{count,days:ACK_DAYS}:{count}}));
  } catch {
    return {error:'기록하지 못했습니다 — 잠시 뒤 다시 해 주세요.'};
  }
  revalidatePath('/admin/status');
  return {message:input.hide?`${ACK_DAYS}일 동안 숨깁니다.`:'다시 보입니다.'};
}
