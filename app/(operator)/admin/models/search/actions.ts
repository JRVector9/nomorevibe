'use server';

import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { saveSearchModelSettings } from '@/lib/domain/products/search-model-repository';
import { webWriteAction } from '@/lib/operations/dr/web-gate';

export type SearchModelActionState = { ok?: true; message?: string; issues?: string[] } | null;

const REVISION = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PATHS = ['/admin/models/search', '/admin/models', '/admin/models/tasks', '/admin/flow'];
const DENIED: SearchModelActionState = { issues: ['관리자 로그인과 쓰기 권한을 확인하세요.'] };

const field = (form: FormData, name: string) => { const value = form.get(name); return typeof value === 'string' ? value.trim() : ''; };
const hasControl = (value: string): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
};

function parse(form: FormData): { revision: string; kind: 'embedding' | 'rerank'; connectionId: string; model: string } | null {
  const revision = field(form, 'revision');
  const kind = field(form, 'kind');
  const connectionId = field(form, 'connectionId');
  const model = field(form, 'model');
  if (!REVISION.test(revision) || (kind !== 'embedding' && kind !== 'rerank') || !UUID.test(connectionId)
    || !model || model.length > 200 || hasControl(model)) return null;
  return { revision, kind, connectionId, model };
}

function issueMessage(issue: string): string {
  if (issue.includes('revision')) return '다른 운영자가 먼저 설정을 바꿨습니다. 화면을 새로고침한 뒤 다시 선택하세요.';
  if (issue.includes('connection') && issue.includes('change')) return '선택한 연결이 바뀌었습니다. 화면을 새로고침한 뒤 다시 선택하세요.';
  if (issue.includes('parity')) return '기존 저장 벡터와의 호환성 검증을 통과하지 못했습니다. 모델과 API를 확인하세요.';
  if (issue.includes('sample')) return '비교할 기존 저장 벡터가 부족합니다. 색인 상태를 확인하세요.';
  if (issue.includes('key') && issue.includes('unreadable')) return '연결의 API 키를 읽을 수 없습니다. AI 연결에서 키를 다시 저장하세요.';
  if (/(probe|models|model_not_listed|bad_response|unreachable)/i.test(issue)) return 'API 주소·키·모델을 확인하세요.';
  return '저장하지 못했습니다. 설정이 바뀌었거나 검증을 통과하지 못했습니다. 화면을 새로고침한 뒤 다시 시도하세요.';
}

export const saveSearchModelSettingsAction = webWriteAction(async function saveSearchModelSettingsAction(_previous: SearchModelActionState, form: FormData): Promise<SearchModelActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  if (process.env.MODEL_SERVING_CONTRACTS_DB === '0') return { issues: ['DB 모델 설정 읽기가 꺼져 있어 저장할 수 없습니다.'] };
  const input = parse(form);
  if (!input) return { issues: ['저장 요청 형식이 올바르지 않습니다. 화면을 새로고침한 뒤 연결과 모델을 다시 선택하세요.'] };
  const saved = await saveSearchModelSettings(input, admin.login);
  if (!saved.ok) return { issues: [issueMessage(saved.issue)] };
  for (const path of PATHS) revalidatePath(path);
  return { ok: true, message: input.kind === 'embedding'
    ? '제품·검색어 벡터 API를 함께 저장했습니다. 새 작업부터 반영됩니다.'
    : '재정렬 응답을 확인하고 API를 저장했습니다. 새 작업부터 반영됩니다.' };
});
