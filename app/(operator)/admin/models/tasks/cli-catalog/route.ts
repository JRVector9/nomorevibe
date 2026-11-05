import { NextResponse } from "next/server";
import { currentAdmin } from "@/lib/auth/admin";
import { withRoute } from "@/lib/http/handler";
import { readAdminCliCatalog } from "@/lib/operations/admin-cli-catalog";

export const dynamic = "force-dynamic";

/** Reads model metadata from the existing M3 CLI. It does not install tools, run a model or change a connection. */
export const GET = withRoute("admin.cli_catalog", async request => {
  if (!await currentAdmin()) return NextResponse.json({ error: "관리자 로그인이 필요합니다." }, { status: 403, headers: { "cache-control": "no-store" } });
  const params = new URL(request.url).searchParams;
  const connectionId = params.get("connectionId") || undefined;
  if (connectionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(connectionId))
    return NextResponse.json({ error: "연결을 확인해주세요." }, { status: 400, headers: { "cache-control": "no-store" } });
  try {
    return NextResponse.json({ ok: true, catalog: await readAdminCliCatalog({ connectionId, allowDisabled: !!connectionId, fresh: params.get("refresh") === "1" }) }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return NextResponse.json({ ok: false, error: "M3 OpenCode에 연결하지 못했습니다. 마지막 저장된 선택만 표시합니다." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
});
