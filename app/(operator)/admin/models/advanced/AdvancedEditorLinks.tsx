import Link from "next/link";
import { MODELS_ADVANCED_HREF, MODELS_ADVANCED_LABEL, modelsAdvancedEditor, type ModelsAdvancedEditorId } from "../../workspace-navigation";

/**
 * 고급 설정 아래 편집기 화면의 머리 줄 — 뒤로 가기(← 고급 설정)와 옆 편집기로 건너가는 링크.
 * 글자는 메뉴(WORKSPACE_SECONDARY.modelsAdvanced)와 같은 표(MODELS_ADVANCED_EDITORS)에서 온다 — 화면마다 이름이 갈리지 않게(2026-11-07 PR 5).
 */
export function AdvancedEditorLinks({ next = [] }: { next?: readonly ModelsAdvancedEditorId[] }) {
  return <p className="flex flex-wrap gap-4 text-[13px] text-fg-3">
    <Link href={MODELS_ADVANCED_HREF} prefetch={false}>← {MODELS_ADVANCED_LABEL}</Link>
    {next.map(id => { const editor = modelsAdvancedEditor(id); return <Link key={id} href={editor.href} prefetch={false}>{editor.label} →</Link>; })}
  </p>;
}

/** 편집기 화면의 문서 제목 — 메뉴 이름과 같다 */
export const advancedEditorTitle = (id: ModelsAdvancedEditorId) => `${modelsAdvancedEditor(id).label} — NoMoreVibe`;
