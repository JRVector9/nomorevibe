#!/usr/bin/env bash
# CI 이미지 승격(scripts/ci-promote-image.sh)에 쓰는 crane(google/go-containerregistry)을 고정 버전·checksum 으로 받는다.
# crane 은 registry 의 manifest·설정만 다룬다 — 층을 받거나 다시 올리지 않고 라벨을 바꾼다.
set -euo pipefail

VERSION=v0.22.1
case "$(uname -m)" in
  aarch64|arm64) ASSET=go-containerregistry_Linux_arm64.tar.gz
    SHA256=898c0cff975f898a33e8c4580bdafb0e7c02c7faa33374e946762f97c4ab7110 ;;
  x86_64) ASSET=go-containerregistry_Linux_x86_64.tar.gz
    SHA256=0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 2 ;;
esac

DIR=${RUNNER_TEMP:-/tmp}/crane-$VERSION
mkdir -p "$DIR"
curl -fsSL --retry 3 -o "$DIR/$ASSET" "https://github.com/google/go-containerregistry/releases/download/$VERSION/$ASSET"
echo "$SHA256  $DIR/$ASSET" | sha256sum -c - >/dev/null
tar -xzf "$DIR/$ASSET" -C "$DIR" crane
rm -f "$DIR/$ASSET"
"$DIR/crane" version
if [ -n "${GITHUB_PATH:-}" ]; then echo "$DIR" >> "$GITHUB_PATH"; fi
