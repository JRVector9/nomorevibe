import { extractVerifyMeta } from "@/lib/net/normalize";
import { assertPublicUrl } from "@/lib/net/ssrf";
import { fetchPage } from "@/lib/net/fetch";
import { generateEditToken, hashToken } from "@/lib/tokens";
import { logger } from "@/lib/observability/logger";
import { type Result, ok, fail } from "./errors";
import * as repo from "./repository";
import { isUnclaimed } from "./view";
import { VERIFY_FILE_PATH, VERIFY_META_NAME, verifyExpectation } from "./verify-contract";

export type VerifyOutput = {
  slug: string;
  status: "verified";
  method: "file" | "meta";
  already?: boolean;
  /** 우리가 대신 올린 제품을 주인이 가져갔다 */
  claimed?: true;
  /**
   * 클레임한 경우에만 들어간다. 수집기가 올린 제품의 수정 키는 발행 때 만들어 버렸으므로
   * (아무도 손에 쥐지 않은 상태였다) 주인이 증명한 지금 새로 발급한다. 이 응답에만 나온다.
   */
  edit_token?: string;
};

/**
 * 도메인 소유권 검증 — 우리 서버가 직접 확인한다.
 * 1) <url>/.well-known/nomorevibe.txt 내용이 verify_token과 일치, 또는
 * 2) 페이지의 <meta name="nomorevibe-verify"> content가 일치
 * 둘 다 그 도메인에 배포할 수 있는 사람만 만들 수 있으므로 소유 증명이 된다.
 */
export async function verifyProduct(slug: string): Promise<Result<VerifyOutput>> {
  const product = await repo.findBySlug(slug);
  if (!product || product.status === "banned") return fail({ kind: "not_found" });

  if (product.status === "verified") {
    return ok({ slug, status: "verified", method: (product.verifyMethod as "file" | "meta") ?? "file", already: true });
  }

  const guard = await assertPublicUrl(product.url);
  if (!guard.ok) return fail({ kind: "invalid", message: guard.reason });

  const origin = new URL(product.url).origin;
  let method: "file" | "meta" | null = null;

  const filePage = await fetchPage(`${origin}${VERIFY_FILE_PATH}`);
  if (
    filePage &&
    filePage.status >= 200 &&
    filePage.status < 300 &&
    filePage.html.trim() === product.verifyToken
  ) {
    method = "file";
  }

  if (!method) {
    const page = await fetchPage(product.url);
    if (
      page &&
      page.status >= 200 &&
      page.status < 400 &&
      extractVerifyMeta(page.html, VERIFY_META_NAME) === product.verifyToken
    ) {
      method = "meta";
    }
  }

  if (!method) {
    // 재배포를 안 했는지, 경로가 틀렸는지 구분하려면 파일 응답 코드가 필요하다
    logger.info("verify.failed", { slug, origin, fileStatus: filePage?.status ?? null });
    return fail({ kind: "verification_failed", expected: verifyExpectation(product.verifyToken) });
  }

  /**
   * 우리가 대신 올린 제품이면 이 검증이 곧 클레임이다.
   *
   * 도메인에 토큰을 올릴 수 있는 사람은 그 배포물의 주인이다 — 소유를 증명하는 행위가
   * 이미 여기서 끝난다. 남은 것은 그것을 기록하고, 아무도 쥐고 있지 않던 수정 키를
   * 주인에게 넘기는 일뿐이다.
   */
  const claiming = isUnclaimed(product);
  const editToken = claiming ? generateEditToken() : null;
  const now = new Date();

  await repo.update(product.id, {
    status: "verified",
    verifyMethod: method,
    verifiedAt: now,
    ...(editToken ? { claimedAt: now, editTokenHash: hashToken(editToken) } : {}),
  });

  logger.info("verify.succeeded", { slug, method, claimed: claiming });
  if (editToken) {
    // 수집한 제품에 주인이 나타난 건수는 시드가 실제로 쓸모 있었는지를 말해준다
    logger.info("product.claimed", { slug, url: product.url });
    return ok({ slug, status: "verified", method, claimed: true, edit_token: editToken });
  }
  return ok({ slug, status: "verified", method });
}
