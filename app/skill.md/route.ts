import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { siteOrigin } from "@/lib/site";

/**
 * install.sh가 내려받는 스킬 원본 — repo의 skill/SKILL.md 단일 소스를 서빙.
 * {{SITE_URL}} 플레이스홀더를 배포 origin으로 치환한다.
 */
export async function GET(req: Request) {
  const content = await fs.readFile(path.join(process.cwd(), "skill", "SKILL.md"), "utf-8");
  return new NextResponse(content.replaceAll("{{SITE_URL}}", siteOrigin(req)), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
