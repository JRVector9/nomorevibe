'use server';
import { localCodexEnabled } from '@/lib/auth/local-codex';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { currentAdmin, authSecret, adminLogins } from '@/lib/auth/admin';
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session';
import { agentRequest } from '@/lib/operations/agent-client';
import { requestAdminJob } from '@/lib/operations/admin';
import { setManualCategory } from '@/lib/operations/categories';
import { modelConfigSchema, type AgentStatus } from '@/lib/operations/contracts';
import { CATEGORIES, type Category } from '@/lib/domain/products/schema';
import { db } from '@/lib/db';
import { operationsAudit } from '@/lib/db/schema';
export type ActionResult = { message?: string; error?: string; status?: AgentStatus };
async function actualAdmin() {
  if(localCodexEnabled())return {login:"local"};
  const secret=authSecret();if(!secret)return null;
  const session=await verifySession((await cookies()).get(SESSION_COOKIE)?.value,secret);
  return session && adminLogins().includes(session.login.toLowerCase()) ? session : null;
}
export async function requestOperation(name:string):Promise<ActionResult> {
  const admin=await currentAdmin();if(!admin)return {error:'관리자 로그인이 필요합니다.'};
  try{const message=await requestAdminJob(name,admin.login);revalidatePath('/admin/status');return {message};}catch{return {error:'작업 요청을 처리하지 못했습니다.'};}
}
export async function codexOperation(action:string,data:Record<string,unknown>={}):Promise<ActionResult> {
  // Explicit loopback-only local mode or a real allowlisted session; general UI bypass is insufficient.
  const admin=await actualAdmin();if(!admin)return {error:'관리자 인증이 필요합니다. 서버에서는 허용된 GitHub 계정으로 로그인하고, 로컬에서는 로컬 전용 AI 연결 설정을 확인해주세요.'};
  if(!['status','connect','input','cancel','probe','test','apply'].includes(action))return {error:'허용되지 않은 작업입니다.'};
  try {
    if(action==='test'||action==='apply')data={...data,config:modelConfigSchema.parse(data.config)};
    const status=await agentRequest<AgentStatus>(action,data);
    if(action!=='status')await db.insert(operationsAudit).values({actor:admin.login,action:`ai-${action}`,target:'connect-agent',detail:{generation:status.generation,configVersion:status.configVersion}});
    if(action!=='status')revalidatePath('/admin/status');return {status};
  } catch(error) {return {error:error instanceof Error?error.message:'AI 연결 서비스 요청 실패'};}
}
export async function saveManualCategory(data:{repo:string;sourceHash:string;category:string;reason:string}):Promise<ActionResult> {
  const admin=await currentAdmin();if(!admin)return {error:'관리자 로그인이 필요합니다.'};
  if(!CATEGORIES.includes(data.category as Category))return {error:'카테고리를 선택해주세요.'};
  try {await setManualCategory({...data,category:data.category as Category,actor:admin.login});revalidatePath('/admin/status');return {message:'분류를 저장하고 발행 검토를 요청했습니다. 출처·심사·중복·차단 조건을 다시 확인한 뒤 발행합니다.'};}
  catch(error){return {error:error instanceof Error?error.message:'분류 저장 실패'};}
}
