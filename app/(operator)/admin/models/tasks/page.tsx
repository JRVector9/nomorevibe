import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { LegacyTasksRedirect } from "../unified/LegacyTasksRedirect";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "모델·작업 배정 — NoMoreVibe", robots: { index: false } };

/** 조각 주소는 서버에 오지 않으므로 인증 뒤 브라우저가 옛 #execution/#mode도 보존해 옮긴다. 액션 모듈은 원래 경로에 둔다. */
export default async function AiTasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!await currentAdmin()) redirect("/admin/login");
  return <LegacyTasksRedirect params={await searchParams} />;
}
