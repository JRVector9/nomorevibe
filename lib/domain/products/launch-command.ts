import { BRAND } from "@/lib/copy/brand";

/**
 * 등록 명령의 표기 — /launch·홈 등록 띠(LaunchBand)·설치 스크립트·클레임 초대가 같은 글자를 쓴다(2026-10-08 UX 감사 UX-20).
 * 홈은 '/nomorevibe launch', /launch 는 '/nomorevibe' 로 달랐다. 스킬(skill/SKILL.md)은 인자 없이 부르면 등록이다.
 */
export const LAUNCH_COMMAND = "/nomorevibe";
/** 운영자 확인 — 사이트에 올린 확인 파일을 읽어 ✓ 표시와 수정 키를 준다 */
export const VERIFY_COMMAND = `${LAUNCH_COMMAND} verify`;

/** 스킬 설치 한 줄 — origin 은 siteOrigin() 으로 받는다 */
export function installCommand(origin: string): string {
  return `curl -fsSL ${origin}/install.sh | sh`;
}

/**
 * 설치 스크립트 본문 — /install.sh 가 내주고 /launch 의 '스크립트 내용 보기'가 같은 글자를 보인다.
 * 배포 origin 을 서빙 시점에 박아 넣는다(정적 파일로 두면 기본값이 localhost 로 남아 모든 실제 설치가 깨진다).
 */
export function installScript(site: string): string {
  return `#!/bin/sh
# ${BRAND} 스킬 설치 스크립트
# 사용: ${installCommand(site)}
set -e

SITE="\${NOMOREVIBE_SITE:-${site}}"

echo "${BRAND} 스킬을 설치합니다..."

# Claude Code 스킬
CLAUDE_DIR="$HOME/.claude/skills/nomorevibe"
mkdir -p "$CLAUDE_DIR"
curl -fsSL "$SITE/skill.md" -o "$CLAUDE_DIR/SKILL.md"
echo "✓ Claude Code 스킬 설치됨  $CLAUDE_DIR/SKILL.md"

# Codex 프롬프트
CODEX_DIR="$HOME/.codex/prompts"
mkdir -p "$CODEX_DIR"
curl -fsSL "$SITE/skill.md" -o "$CODEX_DIR/nomorevibe.md"
echo "✓ Codex 프롬프트 설치됨    $CODEX_DIR/nomorevibe.md"

echo ""
echo "이제 프로젝트 폴더에서 ${LAUNCH_COMMAND} 를 실행하세요."
echo "등록 후에는 profile, links, media, provenance, update, refresh 명령으로 근거를 관리할 수 있습니다."
`;
}
