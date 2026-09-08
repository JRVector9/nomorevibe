import { NextResponse } from "next/server";
import { isJobName, JOB_CATALOG } from "@/lib/jobs/catalog";
import { requestJob } from "@/lib/jobs/control";
import { withRoute } from "@/lib/http/handler";

type Params = { params: Promise<{ job: string }> };
const requestableJobs = JOB_CATALOG.filter(job => job.role !== "scheduler").map(job => job.name);

/**
 * 스케줄러 진입점.
 *
 * 인증된 운영 요청을 영속 저장한다. 실제 수집은 독립 worker가 수행한다.
 */
export const POST = withRoute("cron.run", async (req: Request, { params }: Params) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "권한이 없습니다" }, { status: 403 });
  }

  const { job } = await params;
  if (!isJobName(job)) {
    return NextResponse.json({ error: `알 수 없는 작업입니다`, available: requestableJobs }, { status: 404 });
  }
  if (!requestableJobs.includes(job)) {
    return NextResponse.json({ error: "스케줄러 생존 관측은 예약 작업이 아닙니다", available: requestableJobs }, { status: 400 });
  }

  return NextResponse.json(await requestJob(job), { status: 202 });
});
