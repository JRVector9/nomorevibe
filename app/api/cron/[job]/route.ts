import { NextResponse } from "next/server";
import { isJobName, JOB_NAMES } from "@/lib/jobs/catalog";
import { requestJob } from "@/lib/jobs/control";
import { withRoute } from "@/lib/http/handler";

type Params = { params: Promise<{ job: string }> };

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
    return NextResponse.json({ error: `알 수 없는 작업입니다`, available: JOB_NAMES }, { status: 404 });
  }

  return NextResponse.json(await requestJob(job), { status: 202 });
});
