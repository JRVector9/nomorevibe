import type { Product } from "@/lib/db/schema";
import { isPrivateHostname, isPrivateIp } from "@/lib/net/ssrf";
import { type Result, fail, ok } from "./errors";
import * as repo from "./repository";
import { isUnclaimed } from "./view";

/**
 * 클레임 초대.
 *
 * 우리가 대신 올린 제품의 주인은 자기 제품이 올라와 있다는 것을 모른다. 상세 페이지를 볼
 * 일이 없기 때문이다. 레포는 안다(repo_url) — 거기에 이슈 하나를 남기면 닿는다.
 *
 * 자동으로 보내지 않는다. 미리 채운 "새 이슈" 링크를 만들어 운영자가 자기 브라우저에서
 * 직접 제출한다. 우리 서버가 남의 레포에 글을 쓸 자격을 쥐지 않고, 마지막 버튼은 사람이
 * 누른다. 보냈다는 것만 기록해 두 번 보내지 않는다.
 */

/** 이슈 제목·본문. 레포 주인이 어디 사람인지 모르므로 영어로 쓴다 */
function inviteIssue(product: Pick<Product, "name" | "slug">, origin: string) {
  const page = `${origin}/p/${product.slug}`;
  return {
    title: `${product.name} is listed on NoMoreVibe — claim or remove it`,
    body: [
      `Hi! We found this repository through public signals — an AI co-authored commit trailer or a repository topic — and listed the deployed product on NoMoreVibe, a public database of products built with AI.`,
      ``,
      `Listing: ${page}`,
      ``,
      `You have two options — both are one step:`,
      `- **Claim it** to get the ✓ verified badge, edit the listing, and join the weekly ranking: run \`curl -fsSL ${origin}/install.sh | sh\` in your project, then \`/nomorevibe\` in Claude Code or Codex.`,
      `- **Remove it** if you'd rather not be listed: use the takedown form at the bottom of the listing page. No account needed.`,
      ``,
      `Everything we show is either checked by us (domain ownership) or labeled as unverified. Nothing was taken from private sources.`,
      ``,
      `This is the only message we'll send. Feel free to close this issue.`,
    ].join("\n"),
  };
}

/**
 * 이슈 본문에 실을 수 있는 주소인가.
 *
 * NEXT_PUBLIC_SITE_URL이 비면 origin이 http://localhost:3000으로 떨어진다. 그대로 두면 남의
 * 레포에 열리지 않는 상세 페이지 링크와 설치 명령이 실려 나가고, 받는 사람은 확인할 길이 없다.
 * 초대는 사람이 마지막에 제출하지만 본문을 눈으로 검사하리라 기대하지 않는다.
 * 어디가 사설 대상인지는 SSRF 정책이 이미 정의해 두었으므로 그것을 그대로 쓴다.
 */
export function isPublicOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // URL.hostname은 IPv6를 대괄호째 준다
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return !isPrivateHostname(host) && !isPrivateIp(host);
}

/** github.com 레포의 owner/repo. 다른 호스트는 이슈 링크를 만들 수 없다 */
function githubRepo(repoUrl: string | null): string | null {
  if (!repoUrl) return null;
  const match = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(repoUrl.trim());
  return match ? match[1] : null;
}

/**
 * 미리 채운 GitHub "새 이슈" 주소. 초대할 수 없으면(주인이 있거나, GitHub 레포가 아니거나,
 * 본문에 실을 공개 주소가 없음) null.
 * origin은 밖에서 받는다 — 순수하게 두어 셸 환경 없이 잴 수 있게.
 */
export function claimInviteUrl(
  product: Pick<Product, "name" | "slug" | "repoUrl" | "source" | "claimedAt">,
  origin: string,
): string | null {
  if (!isUnclaimed(product)) return null;
  if (!isPublicOrigin(origin)) return null;
  const repo = githubRepo(product.repoUrl);
  if (!repo) return null;
  const issue = inviteIssue(product, origin);
  const params = new URLSearchParams({ title: issue.title, body: issue.body });
  return `https://github.com/${repo}/issues/new?${params.toString()}`;
}

/** 운영자가 초대를 보냈다고 표시한다. 주인이 이미 있으면 표시할 것이 없다 */
export async function markClaimInvited(slug: string): Promise<Result<{ slug: string; invitedAt: Date }>> {
  const product = await repo.findBySlug(slug);
  if (!product) return fail({ kind: "not_found" });
  if (!isUnclaimed(product)) {
    return fail({ kind: "forbidden", message: "주인이 있는 제품에는 초대를 보내지 않습니다" });
  }
  if (product.claimInvitedAt) return ok({ slug, invitedAt: product.claimInvitedAt });

  const invitedAt = new Date();
  await repo.update(product.id, { claimInvitedAt: invitedAt });
  return ok({ slug, invitedAt });
}
