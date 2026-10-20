import { currentAdmin } from "@/lib/auth/admin";

/**
 * SNS 화제 화면(헤더·모바일 탭·홈 대표 구획·/talk·상세 화제 띠) — 화제 글이 2주쯤 쌓인 뒤 운영자가 켠다(C안).
 * 꺼져 있어도 관리자는 /talk·홈·상세에서 미리 본다. 관리자 쿠키가 있는 응답은 Cloudflare 가 저장하지 않는다(next.config.ts).
 */
export function talkPublicEnabled(): boolean {
  return process.env.SNS_TALK_PUBLIC_ENABLED === "true";
}

export async function talkVisibility(): Promise<{ visible: boolean; preview: boolean }> {
  if (talkPublicEnabled()) return { visible: true, preview: false };
  const admin = await currentAdmin().catch(() => null);
  return { visible: Boolean(admin), preview: Boolean(admin) };
}
