import { NextResponse } from "next/server";
import { currentAdmin } from "@/lib/auth/admin";
import { formatDetailTime } from "@/lib/format/time";
import { withRoute } from "@/lib/http/handler";
import { recordAdminAction } from "@/lib/operations/admin-log";
import { toCsv } from "./csv";
import { EXPORT_VIEWS, MAX_EXPORT_ROWS, type ExportViewName } from "./views";

/**
 * 목록 내보내기 — GET /admin/export?view=<products|review|audit|activity|news>&format=<csv|json>&<그 화면의 거르기>
 * (2026-10-08 UX 감사 ADM-34). 읽기만 하고, 관리자만(화면과 같은 currentAdmin), 최대 MAX_EXPORT_ROWS 행.
 * 내려받은 사실은 작업 로그에 남긴다 — 무엇을 어떤 거르기로 몇 행 가져갔는지.
 */
export const dynamic = "force-dynamic";

const FORMATS = ["csv", "json"] as const;

export const GET = withRoute("admin.export", async (request: Request) => {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: "권한이 없습니다. 다시 로그인해주세요." }, { status: 403 });

  const params = new URL(request.url).searchParams;
  const view = params.get("view") ?? "";
  const format = params.get("format") ?? "csv";
  if (!Object.hasOwn(EXPORT_VIEWS, view)) {
    return NextResponse.json({ error: `view 는 ${Object.keys(EXPORT_VIEWS).join("·")} 중 하나입니다.` }, { status: 400 });
  }
  if (!(FORMATS as readonly string[]).includes(format)) return NextResponse.json({ error: "format 은 csv·json 중 하나입니다." }, { status: 400 });

  const spec = EXPORT_VIEWS[view as ExportViewName];
  // 하나 더 읽어 잘렸는지 안다
  const loaded = await spec.load(params, MAX_EXPORT_ROWS + 1);
  const truncated = loaded.length > MAX_EXPORT_ROWS;
  const rows = loaded.slice(0, MAX_EXPORT_ROWS);
  const filters = Object.fromEntries([...params].filter(([key]) => key !== "view" && key !== "format"));
  await recordAdminAction(admin.login, { action: "export", target: `export:${view}`, detail: { format, filters, rows: rows.length, truncated } });

  // 파일 이름의 시각은 한국 시각 — "2026-10-08 13:38:13 KST" → 20261008-1338
  const stamp = formatDetailTime(new Date()).slice(0, 16).replace(/-/g, "").replace(" ", "-").replace(":", "");
  const headers = {
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="nomorevibe-${view}-${stamp}.${format}"`,
    "x-export-rows": String(rows.length),
    "x-export-truncated": truncated ? "1" : "0",
  };
  if (format === "json") {
    return NextResponse.json({ view, exportedAt: new Date().toISOString(), rows: rows.length, truncated, limit: MAX_EXPORT_ROWS, items: rows }, { headers });
  }
  const body = toCsv(spec.columns.map((column) => ({ label: column.label, value: (row: (typeof rows)[number]) => row[column.key] })), rows);
  return new Response(body, { headers: { ...headers, "content-type": "text/csv; charset=utf-8" } });
});
