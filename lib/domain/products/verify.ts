import { extractVerifyMeta } from "@/lib/net/normalize";
import { assertPublicUrl } from "@/lib/net/ssrf";
import { fetchPage } from "@/lib/net/fetch";
import { type Result, ok, fail } from "./errors";
import * as repo from "./repository";
import { VERIFY_FILE_PATH, VERIFY_META_NAME, verifyExpectation } from "./verify-contract";

export type VerifyOutput = { slug: string; status: "verified"; method: "file" | "meta"; already?: boolean };

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
    return fail({ kind: "verification_failed", expected: verifyExpectation(product.verifyToken) });
  }

  await repo.update(product.id, { status: "verified", verifyMethod: method, verifiedAt: new Date() });
  return ok({ slug, status: "verified", method });
}
