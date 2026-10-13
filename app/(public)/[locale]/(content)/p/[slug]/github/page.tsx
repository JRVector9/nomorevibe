import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GithubIntegrationSettings } from "@/components/product-detail/GithubIntegrationSettings";
import { getPublicSession } from "@/lib/domain/accounts/request-auth";
import { productFeedbackEnabled, publicUserAuthEnabled } from "@/lib/domain/github-integration/flags";
import { findBySlug } from "@/lib/domain/products/repository";
import { parseGithubRepository } from "@/lib/github/repositories";

export const dynamic = "force-dynamic";
export const metadata = { title: "GitHub 이슈 수신 설정", robots: { index: false, follow: false } };
type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ pending?: string | string[] }> };

async function MakerSettings({ slug, searchParams }: { slug: string; searchParams: Props["searchParams"] }) {
  const installationPending = (await searchParams).pending === "1";
  const session = await getPublicSession();
  if (!session) return <p className="mt-6 text-[14px] leading-6"><Link prefetch={false} href={`/login?returnTo=${encodeURIComponent(`/p/${slug}/github`)}`} className="underline underline-offset-2">로그인</Link>한 뒤 제품 수정 키로 GitHub 이슈 수신을 설정할 수 있습니다.</p>;
  return <GithubIntegrationSettings slug={slug} csrfToken={session.csrfToken} installationPending={installationPending} />;
}

export default async function GithubSettingsPage({ params, searchParams }: Props) {
  if (!publicUserAuthEnabled() || !productFeedbackEnabled()) notFound();
  const { slug } = await params;
  const product = await findBySlug(slug);
  if (!product || product.status === "banned") notFound();
  const repository = parseGithubRepository(product.repoUrl ?? "");
  return <main className="mx-auto max-w-2xl px-5 py-12 text-fg">
    <Link prefetch={false} href={`/p/${encodeURIComponent(slug)}`} className="text-[14px] underline underline-offset-2">{product.name} 돌아가기</Link>
    <h1 className="mt-6 text-2xl font-semibold">GitHub 이슈 수신 설정</h1>
    {repository ? <>
      <p className="mt-3 text-[14px] leading-6">연결할 저장소: <a href={repository.htmlUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{repository.fullName}</a></p>
      <Suspense fallback={<p className="mt-6 text-[14px]">로그인 상태를 확인하고 있습니다…</p>}><MakerSettings slug={slug} searchParams={searchParams} /></Suspense>
    </> : <p className="mt-6 text-[14px] leading-6">제품 정보에 공개 GitHub 저장소를 등록한 뒤 연결해 주세요.</p>}
  </main>;
}
