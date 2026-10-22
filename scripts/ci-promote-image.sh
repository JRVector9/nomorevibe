#!/usr/bin/env bash
# main push 에서 같은 트리로 PR 이 미리 만든 이미지를 다시 빌드하지 않고 승격한다.
#
#   scripts/ci-promote-image.sh <이미지 저장소> <트리> <main 커밋 SHA>
#   예) scripts/ci-promote-image.sh ghcr.io/jrvector9/nomorevibe-worker 7201…5b 4c34…c0
#   scripts/ci-promote-image.sh --check <이미지 저장소> <트리>   PR 잡: 방금 올린 이미지가 승격 조건을 갖췄는지만 본다(쓰지 않는다)
#
# PR 실행(같은 저장소)은 검사와 함께 `<저장소>:tree-<트리>` 를 올린다(라벨 dev.nomorevibe.tree=<트리>, 단일 arm64 manifest).
# 여기서는 그 이미지가 같은 트리·arm64 인지 확인하고, 층은 그대로 둔 채 설정의 revision 라벨만 main SHA 로 바꿔
# `<저장소>:<main SHA>` 로 올린다(crane mutate — 층을 받거나 다시 올리지 않는다). 배포 도구가 보는 것은 예전과 같다:
# 태그 digest, arm64, org.opencontainers.image.revision == main SHA.
#
# 승격하면 GITHUB_OUTPUT 에 digest=sha256:… 를 남기고 0 으로 끝난다. 미리 만든 이미지가 없거나 하나라도 어긋나면
# 아무것도 남기지 않고 0 으로 끝난다 — 호출하는 잡이 예전처럼 소스에서 빌드한다. crane 자체가 실패하면 0 이 아닌 값으로 끝나고,
# 그때도 잡은 빌드로 넘어간다(continue-on-error).
set -euo pipefail

CHECK_ONLY=false
if [ "${1:-}" = --check ]; then CHECK_ONLY=true; shift; fi
REPOSITORY=${1:?repository}
TREE=${2:?tree}
SHA=${3:-}
[[ "$REPOSITORY" =~ ^ghcr\.io/jrvector9/[a-z0-9-]+$ ]] || { echo "unexpected repository: $REPOSITORY" >&2; exit 2; }
[[ "$TREE" =~ ^[0-9a-f]{40}$ ]] || { echo "tree must be a full hash" >&2; exit 2; }
[[ "$CHECK_ONLY" = true || "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "sha must be a full hash" >&2; exit 2; }
# --check 는 조건이 안 맞으면 실패한다(PR 잡에 드러나게). 승격은 조건이 안 맞으면 조용히 빌드로 넘긴다.
skip() { echo "$1"; if [ "$CHECK_ONLY" = true ]; then exit 1; fi; exit 0; }

SOURCE="$REPOSITORY:tree-$TREE"
TARGET="$REPOSITORY:$SHA"

if ! crane manifest "$SOURCE" > "${RUNNER_TEMP:-/tmp}/promote-source-manifest.json" 2>/dev/null; then
  skip "No prebuilt image for tree $TREE — building from source"
fi
MEDIA_TYPE=$(jq -r '.mediaType // empty' "${RUNNER_TEMP:-/tmp}/promote-source-manifest.json")
case "$MEDIA_TYPE" in
  application/vnd.oci.image.manifest.v1+json|application/vnd.docker.distribution.manifest.v2+json) ;;
  *) skip "Prebuilt image is not a single image manifest ($MEDIA_TYPE) — building from source" ;;
esac

config_check() { # <ref> <expected revision or empty>
  crane config "$1" | jq -e --arg tree "$TREE" --arg revision "$2" '
    .architecture == "arm64" and .os == "linux"
    and .config.Labels["dev.nomorevibe.tree"] == $tree
    and ($revision == "" or .config.Labels["org.opencontainers.image.revision"] == $revision)' > /dev/null
}

if ! config_check "$SOURCE" ""; then
  skip "Prebuilt image labels or platform do not match tree $TREE — building from source"
fi

SOURCE_REF="$REPOSITORY@$(crane digest "$SOURCE")"
if [ "$CHECK_ONLY" = true ]; then
  echo "Promotable: $SOURCE_REF (single arm64 manifest, dev.nomorevibe.tree=$TREE)"
  exit 0
fi
echo "Promoting $SOURCE_REF to $TARGET"
crane mutate "$SOURCE_REF" --label "org.opencontainers.image.revision=$SHA" --tag "$TARGET" > /dev/null

PROMOTED=$(crane digest "$TARGET")
[[ "$PROMOTED" =~ ^sha256:[0-9a-f]{64}$ ]]
config_check "$REPOSITORY@$PROMOTED" "$SHA"
# 층은 바뀌지 않았다 — 설정만 새로 썼다
diff <(jq -c '[.layers[].digest]' "${RUNNER_TEMP:-/tmp}/promote-source-manifest.json") \
     <(crane manifest "$REPOSITORY@$PROMOTED" | jq -c '[.layers[].digest]') > /dev/null
echo "Promoted $REPOSITORY@$PROMOTED (same layers as $SOURCE_REF)"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "digest=$PROMOTED" >> "$GITHUB_OUTPUT"; fi
