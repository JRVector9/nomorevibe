#!/bin/bash
# M1 Qwen 사설 relay 설치물. 운영 실행은 별도 승인 뒤에만 한다.
# plan은 파일·서비스·모델을 바꾸지 않는다. oMLX의127.0.0.1:8000은 그대로 둔다.
set -euo pipefail

ROOT=/usr/local/nmv-llm-relay
STATE=/var/nmvllm
ACCOUNT=_nmvllm
LABEL=bot.brut.nmv-llm-relay
PLIST=/Library/LaunchDaemons/$LABEL.plist
CONFIG=$ROOT/config.env
REPO=https://github.com/JRVector9/nomorevibe.git
STAGE=""
LOCKED=0

die() { echo "local-model-relay: $*" >&2; exit 1; }
cleanup() {
  if [ -n "$STAGE" ] && [[ "$STAGE" == "$ROOT/releases/.stage."* ]]; then rm -rf "$STAGE"; fi
  if [ "$LOCKED" = 1 ]; then rmdir "$ROOT/.install-lock" 2>/dev/null || true; fi
}
trap cleanup EXIT
need_root() { [ "$(id -u)" = 0 ] || die "sudo가 필요하다"; }
need_macos() { [ "$(uname -s)" = Darwin ] || die "macOS M1 전용이다"; }
node_bin() {
  local candidate="${NODE_BIN:-$(command -v node || true)}"
  [ -x "$candidate" ] || die "NODE_BIN에 Node24 실행 파일을 지정한다"
  [ "$("$candidate" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || die "Node24 이상이 필요하다"
  [[ "$candidate" == /* ]] || die "NODE_BIN은 절대경로여야 한다"
  printf '%s\n' "$candidate"
}

validate() {
  [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || die "--sha에 검토한 커밋40자를 지정한다"
  "$NODE" -e '
    const net=require("node:net"); const [host,clients,port,revision]=process.argv.slice(1);
    const privateIp=v=>net.isIP(v)===4&&v.split(".")[0]==="100"&&+v.split(".")[1]>=64&&+v.split(".")[1]<=127;
    if(!privateIp(host)||!clients||clients.split(",").some(v=>!privateIp(v))||!/^\d+$/.test(port)||+port<1024||+port>65535||!/^[-a-zA-Z0-9._:]{1,200}$/.test(revision))process.exit(1);
  ' "$HOST" "$ALLOW_FROM" "$PORT" "$DEPLOYMENT_REVISION" || die "Tailscale IPv4·허용 목록·port·deployment revision을 확인한다"
}

parse_install() {
  TARGET_SHA="" HOST="" ALLOW_FROM="" KEY_SOURCE="" PORT=8792 DEPLOYMENT_REVISION=unverified
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || die "인자 값이 없다"
    case "$1" in
      --sha) TARGET_SHA=$2 ;;
      --host) HOST=$2 ;;
      --allow-from) ALLOW_FROM=$2 ;;
      --port) PORT=$2 ;;
      --upstream-key-file) KEY_SOURCE=$2 ;;
      --deployment-revision) DEPLOYMENT_REVISION=$2 ;;
      *) die "모르는 인자" ;;
    esac
    shift 2
  done
  NODE="$(node_bin)"; validate
  [[ "$KEY_SOURCE" == /* ]] || die "--upstream-key-file은 oMLX 키의 절대경로다"
}

ensure_account() {
  if dscl . -read "/Users/$ACCOUNT" >/dev/null 2>&1; then
    [ "$(dscl . -read "/Users/$ACCOUNT" NFSHomeDirectory | cut -d ' ' -f2-)" = "$STATE" ] || die "기존 서비스 계정 설정이 다르다"
    [ "$(dscl . -read "/Users/$ACCOUNT" UserShell | cut -d ' ' -f2-)" = /usr/bin/false ] || die "기존 계정은 로그인 없는 서비스 계정이어야 한다"
    return
  fi
  local candidate chosen=""
  for candidate in $(seq 260 399); do
    if ! dscl . -search /Users UniqueID "$candidate" | grep -q . && ! dscl . -search /Groups PrimaryGroupID "$candidate" | grep -q .; then
      chosen=$candidate; break
    fi
  done
  [ -n "$chosen" ] || die "빈 서비스 uid/gid가 없다"
  dscl . -create "/Groups/$ACCOUNT"; dscl . -create "/Groups/$ACCOUNT" PrimaryGroupID "$chosen"
  dscl . -create "/Groups/$ACCOUNT" Password '*'
  dscl . -create "/Users/$ACCOUNT"; dscl . -create "/Users/$ACCOUNT" UniqueID "$chosen"
  dscl . -create "/Users/$ACCOUNT" PrimaryGroupID "$chosen"
  dscl . -create "/Users/$ACCOUNT" NFSHomeDirectory "$STATE"
  dscl . -create "/Users/$ACCOUNT" UserShell /usr/bin/false
  dscl . -create "/Users/$ACCOUNT" Password '*'; dscl . -create "/Users/$ACCOUNT" IsHidden 1
}

fetch_release() {
  [ ! -L "$ROOT" ] && [ ! -L "$ROOT/releases" ] || die "설치 경로가 symlink다"
  mkdir -p "$ROOT/releases"
  mkdir "$ROOT/.install-lock" 2>/dev/null || die "다른 설치가 실행 중이다"
  LOCKED=1
  local target="$ROOT/releases/$TARGET_SHA"
  if [ ! -e "$target" ]; then
    STAGE="$(mktemp -d "$ROOT/releases/.stage.XXXXXX")"
    git init -q "$STAGE"; git -C "$STAGE" fetch -q --depth 1 "$REPO" "$TARGET_SHA"
    git -C "$STAGE" checkout -q --detach FETCH_HEAD
    [ "$(git -C "$STAGE" rev-parse HEAD)" = "$TARGET_SHA" ] || die "다운로드 SHA 불일치"
    (cd "$STAGE" && PATH="$(dirname "$NODE"):$PATH" npm ci --no-audit --no-fund >/dev/null)
    [ -f "$STAGE/scripts/local-model-relay/server.ts" ] || die "relay가 없는 릴리스다"
    touch "$STAGE/.installed"; mv "$STAGE" "$target"; STAGE=""
  fi
  [ -f "$target/.installed" ] && [ ! -L "$target" ] || die "불완전한 릴리스다"
  [ -f "$target/scripts/local-model-relay/server.ts" ] || die "relay 실행 파일이 없다"
  chown root:wheel "$ROOT" "$ROOT/releases"; chmod 755 "$ROOT" "$ROOT/releases"
  chown -R root:wheel "$target"; chmod -R a+rX,go-w "$target"
}

write_config() {
  umask 077
  {
    printf 'CURRENT_SHA=%q\nHOST=%q\nPORT=%q\nALLOW_FROM=%q\nNODE=%q\nDEPLOYMENT_REVISION=%q\n' \
      "$TARGET_SHA" "$HOST" "$PORT" "$ALLOW_FROM" "$NODE" "$DEPLOYMENT_REVISION"
  } > "$CONFIG"
  chmod 600 "$CONFIG"
}

run_entry() {
  (cd "$ROOT/current" && LOCAL_MODEL_RELAY_HOST="$HOST" LOCAL_MODEL_RELAY_PORT="$PORT" \
    LOCAL_MODEL_RELAY_ALLOW_FROM="$ALLOW_FROM,$HOST" LOCAL_MODEL_RELAY_VERSION="$CURRENT_SHA" \
    LOCAL_MODEL_RELAY_DEPLOYMENT_REVISION="$DEPLOYMENT_REVISION" LOCAL_MODEL_RELAY_STATE_DIR="$STATE/receipts" \
    LOCAL_MODEL_RELAY_TOKEN_FILE="$STATE/relay-token" LOCAL_MODEL_RELAY_UPSTREAM_TOKEN_FILE="$STATE/upstream-token" \
    "$NODE" --import tsx scripts/local-model-relay/server.ts "$1")
}

stop_service() {
  if launchctl print "system/$LABEL" >/dev/null 2>&1; then launchctl bootout "system/$LABEL"; fi
}

write_service() {
  [ ! -e "$ROOT/current" ] || [ -L "$ROOT/current" ] || die "current가 symlink가 아니다"
  ln -sfn "$ROOT/releases/$TARGET_SHA" "$ROOT/current"
  CURRENT_SHA=$TARGET_SHA; write_config
  "$NODE" - "$PLIST" "$NODE" "$ROOT/current" "$STATE" "$HOST" "$PORT" "$ALLOW_FROM,$HOST" "$CURRENT_SHA" "$DEPLOYMENT_REVISION" "$ACCOUNT" "$LABEL" <<'JS'
const fs=require("node:fs");
const [file,node,cwd,state,host,port,allow,revision,deployment,account,label]=process.argv.slice(2);
const xml=value=>String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const string=value=>`<string>${xml(value)}</string>`;
const env={PATH:"/usr/bin:/bin:/usr/sbin:/sbin",TMPDIR:`${state}/tmp/`,NODE_ENV:"production",LOCAL_MODEL_RELAY_HOST:host,
  LOCAL_MODEL_RELAY_PORT:port,LOCAL_MODEL_RELAY_ALLOW_FROM:allow,LOCAL_MODEL_RELAY_VERSION:revision,
  LOCAL_MODEL_RELAY_DEPLOYMENT_REVISION:deployment,LOCAL_MODEL_RELAY_STATE_DIR:`${state}/receipts`,
  LOCAL_MODEL_RELAY_TOKEN_FILE:`${state}/relay-token`,LOCAL_MODEL_RELAY_UPSTREAM_TOKEN_FILE:`${state}/upstream-token`};
fs.writeFileSync(file,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key>${string(label)}<key>UserName</key>${string(account)}<key>GroupName</key>${string(account)}
<key>ProgramArguments</key><array>${[node,"--import","tsx","scripts/local-model-relay/server.ts"].map(string).join("")}</array>
<key>WorkingDirectory</key>${string(cwd)}<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v])=>`<key>${xml(k)}</key>${string(v)}`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>100</integer>
<key>StandardOutPath</key>${string(`${state}/logs/relay.log`)}<key>StandardErrorPath</key>${string(`${state}/logs/relay.log`)}</dict></plist>`,{mode:0o644});
JS
  chown root:wheel "$PLIST"; chmod 644 "$PLIST"
  run_entry check
  launchctl bootstrap system "$PLIST"
}

case "${1:-}" in
  plan)
    shift; parse_install "$@"
    "$NODE" -e 'const [sha,host,port,allow]=process.argv.slice(1); console.log(JSON.stringify({action:"plan",sha,host,port:+port,allowedClients:allow.split(","),upstream:"127.0.0.1:8000",nativeCapacityReady:false,mutations:false}))' \
      "$TARGET_SHA" "$HOST" "$PORT" "$ALLOW_FROM"
    ;;
  install)
    need_root; need_macos; shift; parse_install "$@"
    [ ! -e "$CONFIG" ] || die "이미 설치됐다 — upgrade를 사용한다"
    [ -f "$KEY_SOURCE" ] && [ ! -L "$KEY_SOURCE" ] || die "일반 upstream key 파일이 필요하다"
    [ ! -L "$ROOT" ] && [ ! -L "$STATE" ] || die "설치/상태 경로가 symlink다"
    mkdir -p "$ROOT"; ensure_account
    for directory in "$STATE/receipts" "$STATE/logs" "$STATE/tmp"; do [ ! -L "$directory" ] || die "상태 하위 경로가 symlink다"; done
    mkdir -p "$STATE/receipts" "$STATE/logs" "$STATE/tmp"
    chmod 700 "$STATE" "$STATE/receipts" "$STATE/logs" "$STATE/tmp"
    [ ! -e "$STATE/receipts/active.json" ] || die "원격 미종료 기록을 먼저 검토한다"
    if [ ! -e "$STATE/relay-token" ]; then (umask 077; openssl rand -hex 32 > "$STATE/relay-token"); fi
    install -m 400 "$KEY_SOURCE" "$STATE/upstream-token"
    chmod 400 "$STATE/relay-token" "$STATE/upstream-token"
    chown "$ACCOUNT:$ACCOUNT" "$STATE" "$STATE/receipts" "$STATE/logs" "$STATE/tmp" "$STATE/relay-token" "$STATE/upstream-token"
    fetch_release; write_service
    echo "relay 설치물을 등록했다. 모델 준비 여부는 별도 worker 경로 검증 후 판단한다."
    ;;
  upgrade)
    need_root; need_macos; shift
    [ -f "$CONFIG" ] || die "먼저 install"
    # root 소유0600 파일이며 token 값은 저장하지 않는다.
    . "$CONFIG"
    TARGET_SHA=""
    while [ $# -gt 0 ]; do
      [ $# -ge 2 ] || die "인자 값이 없다"
      case "$1" in --sha) TARGET_SHA=$2 ;; --deployment-revision) DEPLOYMENT_REVISION=$2 ;; *) die "모르는 인자" ;; esac
      shift 2
    done
    validate; [ ! -e "$STATE/receipts/active.json" ] || die "호출을 drain·정산한 뒤 upgrade한다"
    fetch_release; stop_service
    [ ! -e "$STATE/receipts/active.json" ] || die "종료 불명 호출이 남아 새 relay를 시작하지 않는다"
    write_service
    ;;
  status)
    need_root; need_macos; [ -f "$CONFIG" ] || die "등록된 설정이 없다"
    . "$CONFIG"; run_entry status
    ;;
  stop)
    need_root; need_macos; stop_service
    ;;
  uninstall)
    need_root; need_macos; stop_service
    [ ! -e "$PLIST" ] || rm "$PLIST"
    echo "서비스 등록만 제거했다. 키·receipt·릴리스·서비스 계정은 감사/복구를 위해 보존한다."
    ;;
  *) die "plan|install|upgrade|status|stop|uninstall" ;;
esac
