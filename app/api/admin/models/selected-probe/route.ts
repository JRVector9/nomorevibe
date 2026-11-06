import { NextResponse } from 'next/server';
import { adminMutationOriginAllowed } from '@/lib/auth/admin-access';
import { currentAdmin } from '@/lib/auth/admin';
import { withRoute } from '@/lib/http/handler';
import { runAdminSelectedModelProbe, type SelectedModelProbeResult } from '@/lib/operations/admin-selected-model-probe';

export const runtime = 'nodejs';
export const maxDuration = 45;
export const dynamic = 'force-dynamic';

const BODY_LIMIT = 2_048;
const NO_STORE = Object.freeze({ 'Cache-Control': 'private, no-store', 'Cloudflare-CDN-Cache-Control': 'no-store' });

function respond(result: SelectedModelProbeResult, status = 200): NextResponse {
  return NextResponse.json(result, { status, headers: NO_STORE });
}

function statusFor(result: SelectedModelProbeResult): number {
  if (result.ok) return 200;
  if (result.error === 'unauthorized') return 401;
  if (result.error === 'forbidden') return 403;
  if (result.error === 'invalid_request') return 400;
  if (result.error === 'cooldown') return 429;
  return 200;
}

async function readJsonBounded(req: Request, limit: number): Promise<unknown | null> {
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) return null;
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } catch { return null; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { return null; }
}

export const POST = withRoute('admin.models.selected-probe', async (req: Request) => {
  if (!adminMutationOriginAllowed(req.headers)) return respond({ ok: false, model: '', error: 'forbidden' }, 403);
  const admin = await currentAdmin();
  if (!admin?.login) return respond({ ok: false, model: '', error: 'unauthorized' }, 401);
  const body = await readJsonBounded(req, BODY_LIMIT);
  if (body === null) return respond({ ok: false, model: '', error: 'invalid_request' }, 400);
  const result = await runAdminSelectedModelProbe(body, admin.login);
  return respond(result, statusFor(result));
});
