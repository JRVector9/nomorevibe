'use server';
import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { agentRequest } from '@/lib/operations/agent-client';
import { requestAdminJob } from '@/lib/operations/admin';
import { setManualCategory } from '@/lib/operations/categories';
import { modelConfigSchema, type AgentStatus } from '@/lib/operations/contracts';
import { CATEGORIES, type Category } from '@/lib/domain/products/schema';
import { recordAdminAction } from '@/lib/operations/admin-log';
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
