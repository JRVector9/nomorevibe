import { NextResponse } from 'next/server';
import { currentAdmin } from '@/lib/auth/admin';
import { FLOW_PROMPT_STAGES, isFlowPromptStage } from '@/lib/operations/flow-prompts-contract';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  if (!await currentAdmin()) {
    return NextResponse.json({ error: '관리자 로그인이 필요합니다.' }, { status: 403, headers });
  }
  const stage = new URL(request.url).searchParams.get('stage');
  if (stage === null || !isFlowPromptStage(stage)) {
    return NextResponse.json({ error: `stage는 다음 중 하나여야 합니다: ${FLOW_PROMPT_STAGES.join(', ')}` }, { status: 400, headers });
  }
  try {
    const { readFlowPrompts } = await import('@/lib/operations/flow-prompts');
    return NextResponse.json(await readFlowPrompts(stage), { headers });
  } catch {
    return NextResponse.json({ error: '프롬프트 템플릿을 읽지 못했습니다.' }, { status: 503, headers });
  }
}
