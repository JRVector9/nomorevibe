import { NextResponse } from "next/server";
import { siteOrigin } from "@/lib/site";

/**
 * 설치 스크립트 — 배포 origin을 서빙 시점에 박아 넣는다.
 * (정적 파일로 두면 기본값이 localhost로 남아 모든 실제 설치가 깨진다)
 */
export async function GET(req: Request) {
  const site = siteOrigin(req);
  const script = `#!/bin/sh
# NoMoreVibe 스킬 설치 스크립트
# 사용: curl -fsSL ${site}/install.sh | sh
set -e

SITE="\${NOMOREVIBE_SITE:-${site}}"

echo "NoMoreVibe 스킬을 설치합니다..."

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
echo "이제 프로젝트 폴더에서 /nomorevibe 를 실행하세요."
`;
  return new NextResponse(script, {
    headers: { "content-type": "text/x-shellscript; charset=utf-8" },
  });
}
