import { MeLoginRequired } from "@/components/me/MeLoginRequired";
import { ProjectsView } from "@/components/me/projects/ProjectsView";
import { meMetadata } from "@/lib/me/metadata";
import { getMeSession } from "@/lib/me/session";

export const dynamic = "force-dynamic";
export const generateMetadata = () => meMetadata("projects");

/** 내 프로젝트 탭(MY5·MY6) — 로그인한 계정의 확인한 프로젝트·받은 의견. ?view=inbox 는 받은 의견 전체(&page= 로 쪽) */
export default async function MeProjectsPage({ searchParams }: PageProps<"/[locale]/me/projects">) {
  const session = await getMeSession();
  if (!session) return <MeLoginRequired tab="projects" />;
  const { view, page } = await searchParams;
  return <ProjectsView userId={session.user.id} csrfToken={session.csrfToken} view={view === "inbox" ? "inbox" : "default"}
    page={typeof page === "string" && /^[1-9][0-9]{0,3}$/.test(page) ? Number(page) : 1} />;
}
