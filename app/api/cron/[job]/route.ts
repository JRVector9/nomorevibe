import { NextResponse } from "next/server";
import { JOBS, JOB_NAMES } from "@/lib/jobs/registry";
import { runJob } from "@/lib/jobs/runner";
import { withRoute } from "@/lib/http/handler";

type Params = { params: Promise<{ job: string }> };

/**
 * 스케줄러 진입점.
 *
 * 외부 cron(Dokploy, GitHub Actions 등)이 주기적으로 호출한다.
 * 한 틱은 시간 예산 안에서 끝나므로, 남은 일은 다음 호출이 이어받는다.
 */
export const POST = withRoute("cron.run", async (req: Request, { params }: Params) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "권한이 없습니다" }, { status: 403 });
  }

  const { job } = await params;
  const handler = JOBS[job];
  if (!handler) {
    return NextResponse.json({ error: `알 수 없는 작업입니다`, available: JOB_NAMES }, { status: 404 });
  }

  const result = await runJob(job, handler);
  // 잠금 때문에 건너뛴 것은 정상이다 — 스케줄러가 재시도하게 만들면 안 된다
  return NextResponse.json({ job, ...result });
});
