import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { getSettings, getSettingsMeta } from "@/lib/crawl/settings";
import { categoryCounts } from "@/lib/domain/products/repository";
import { CategoryDefinitionsForm } from "./CategoryDefinitionsForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "카테고리 기준 — NoMoreVibe", robots: { index: false } };

export default async function AdminCategoriesPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const [settings, meta, counts] = await Promise.all([
    getSettings(),
    getSettingsMeta(),
    categoryCounts({ statuses: ["verified", "seeded"] }),
  ]);

  return (
    <main className="mx-auto max-w-[1100px] px-6 pb-20">
      <div className="flex flex-wrap items-baseline gap-3 pt-6">
        <h1 className="text-[22px] font-extrabold tracking-tight">카테고리 기준</h1>
        <p className="text-[13px] text-fg-3">분류 모델에 전달되는 문장</p>
      </div>

      <p className="mt-4 max-w-[68ch] text-[13.5px] leading-[1.7] text-fg-2">
        여기 적은 정의가 발행 워커의 분류 요청에 그대로 들어갑니다. 판정 규칙과 같은 이유로
        데이터입니다 — 재배포 없이 다음 분류부터 적용됩니다. &ldquo;이건 왜 Dev로 갔지?&rdquo;가
        반복되면 그 카테고리의 <b className="font-semibold">여기에 넣지 말 것</b>에 한 줄 추가하세요.
      </p>

      {meta && (
        <p className="mt-1.5 font-mono text-[13px] text-fg-3">
          마지막 변경 {meta.updatedBy ?? "알 수 없음"} ·{" "}
          {meta.updatedAt.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })}
        </p>
      )}

      <div className="mt-6">
        <CategoryDefinitionsForm definitions={settings.classify.definitions} counts={counts} />
      </div>
    </main>
  );
}
