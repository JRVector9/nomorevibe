#!/bin/bash
# 검색 모델 서버 — bge-m3 임베딩(18081)과 bge-reranker-v2-m3 재정렬(18082)을 llama.cpp llama-server 로 띄운다.
#
# 서버 Mac(M3, 예비로 mini)에서 사용자 launchd 에이전트로 돈다. Ollama 와 따로 둔다 — Ollama 는 자동 업데이트로 엔진이
# 바뀌면 저장된 제품 벡터와 새 검색어 벡터가 조용히 어긋날 수 있고, 쉬면 모델을 내려 첫 검색이 1.4초를 기다리며,
# 재정렬 API 가 없다(2026-10-07 실측: docs/operations/search-model-servers.md).
#
# 실행 파일과 모델은 해시로 고정한다. 임베딩 모델은 Ollama bge-m3 와 같은 파일이라 그동안 잰 벡터와 같다.
#   scripts/ops/search-models.sh install   # 받기·확인·등록(이미 있으면 건너뛴다)
#   scripts/ops/search-models.sh status
set -euo pipefail

ROOT="$HOME/nmv-search"
BUILD=b11429
BIN="$ROOT/bin/$BUILD/llama-$BUILD/llama-server"
RELEASE_SHA=740288ec6887be94280a5dfa25b5e23a78285cab104519e6c7e218904ee82459
EMBED_MODEL="$ROOT/models/bge-m3-f16.gguf"
EMBED_SHA=daec91ffb5dd0c27411bd71f29932917c49cf529a641d0168496c3a501e3062c
RERANK_MODEL="$ROOT/models/bge-reranker-v2-m3-f16.gguf"
RERANK_SHA=5df93be121c09c43432102ad2b9569d369ccb85c209ca7583e8ccd28f0e41b88
# gpustack/bge-reranker-v2-m3-GGUF 의 FP16 — 받을 때 커밋을 고정한다
RERANK_URL=https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/3093af03b1a635e67b084b1d8c03c5f5e020fd05/bge-reranker-v2-m3-FP16.gguf
EMBED_URL=https://huggingface.co/gpustack/bge-m3-GGUF/resolve/2d48f1737679ad900d5c26c5aad5410e9c70fdca/bge-m3-FP16.gguf

verify() { echo "$2  $1" | shasum -a 256 -c - >/dev/null; }

fetch() { # 경로 해시 주소
  if [ -f "$1" ] && verify "$1" "$2"; then return; fi
  curl -fsSLo "$1.part" "$3"
  verify "$1.part" "$2" || { echo "hash mismatch: $1" >&2; rm -f "$1.part"; exit 1; }
  mv "$1.part" "$1"
}

plist() { # 이름 포트 모델 [추가 인자...]
  local name=$1 port=$2 model=$3; shift 3
  local args=""
  for a in "$BIN" -m "$model" --host 0.0.0.0 --port "$port" -c 16384 -b 2048 -ub 2048 -np 8 --no-webui --log-verbosity 2 "$@"; do
    args="$args<string>$a</string>"
  done
  cat > "$HOME/Library/LaunchAgents/bot.brut.$name.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>bot.brut.$name</string>
  <key>ProgramArguments</key><array>$args</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/$name.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/$name.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/bot.brut.$name" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/bot.brut.$name.plist"
}

case "${1:-}" in
  install)
    mkdir -p "$ROOT/bin/$BUILD" "$ROOT/models"
    if [ ! -x "$BIN" ]; then
      fetch "$ROOT/bin/llama-$BUILD.tar.gz" "$RELEASE_SHA" "https://github.com/ggml-org/llama.cpp/releases/download/$BUILD/llama-$BUILD-bin-macos-arm64.tar.gz"
      tar -xzf "$ROOT/bin/llama-$BUILD.tar.gz" -C "$ROOT/bin/$BUILD" && rm "$ROOT/bin/llama-$BUILD.tar.gz"
      xattr -dr com.apple.quarantine "$ROOT/bin/$BUILD" 2>/dev/null || true
    fi
    fetch "$EMBED_MODEL" "$EMBED_SHA" "$EMBED_URL"
    fetch "$RERANK_MODEL" "$RERANK_SHA" "$RERANK_URL"
    plist nmv-embed 18081 "$EMBED_MODEL" --embedding
    plist nmv-rerank 18082 "$RERANK_MODEL" --reranking
    ;;
  status)
    for p in 18081 18082; do printf '%s ' "$p"; curl -fsS -m 2 "http://127.0.0.1:$p/health" || echo down; echo; done
    ;;
  *) echo "usage: $0 install|status" >&2; exit 2 ;;
esac
