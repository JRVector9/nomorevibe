import { NextResponse } from "next/server";
import { installScript } from "@/lib/domain/products/launch-command";
import { siteOrigin } from "@/lib/site";

/**
 * 설치 스크립트 — 배포 origin을 서빙 시점에 박아 넣는다.
 * (정적 파일로 두면 기본값이 localhost로 남아 모든 실제 설치가 깨진다)
 * 본문은 /launch 의 '스크립트 내용 보기'와 같은 함수에서 나온다.
 */
export async function GET(req: Request) {
  return new NextResponse(installScript(siteOrigin(req)), {
    headers: { "content-type": "text/x-shellscript; charset=utf-8" },
  });
}
