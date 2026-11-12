import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { readHumanBatches, readHumanThreshold } from "@/lib/operations/human-batches-read";
import { rejectSampleThreshold } from "@/lib/operations/delegate-threshold-samples";
import { PageStamp } from "../../components/PageStamp";
import { HumanBatches, HumanThreshold } from "./HumanBatches";
import "./batches.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "사람 확인 — NoMoreVibe", robots: { index: false } };
type Search = Record<string, string | string[] | undefined>;

/**
 * 메뉴 「사람 확인」의 기본 화면(2026-11-12 운영 콘솔 개편 조각 3b) — 묶음으로 보고 묶음마다 한 번에 끝낸다.
 * 기존 목록·상세(/admin/review)는 「하나씩 보기」로 그대로 남는다. ?rejects=0.85 는 문턱 보기의 그 구간 거절 표본을 연다.
 */
export default async function HumanBatchesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const params = await searchParams;
  const rejectsAt = rejectSampleThreshold(params.rejects);
  const data = await readHumanBatches(admin.login);
  return <main className="stack human-batches-page"><PageStamp /><h1 className="sr-only">사람 확인</h1>
    <HumanBatches data={data} threshold={<Suspense fallback={<p className="hb-none hb-box" role="status">문턱 미리보기를 읽는 중입니다.</p>}>
      <HumanThreshold load={readHumanThreshold(rejectsAt)} rejectsAt={rejectsAt} /></Suspense>} />
  </main>;
}
