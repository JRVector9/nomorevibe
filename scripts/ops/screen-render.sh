#!/bin/bash
# 화면 서버 — 화면 판별(audit-screen-review)이 부르는 헤드리스 Chromium 서비스를 m1-studio(macOS, Apple Silicon)에 올린다.
# 설계·보안·켜는 순서: docs/operations/2026-10-22-screen-review-design.md
#
#   sudo scripts/ops/screen-render.sh install --sha <main 커밋 40자> --host <m1 Tailscale IPv4> --allow-from <M3 IP>,<mini IP>
#   sudo scripts/ops/screen-render.sh upgrade --sha <main 커밋 40자>      # 같은 설정으로 판만 바꾼다
#   sudo scripts/ops/screen-render.sh status
#   sudo scripts/ops/screen-render.sh firewall                             # Homebrew 로 node 를 올린 뒤: macOS 방화벽에 새 node 를 다시 허용
#   sudo scripts/ops/screen-render.sh pf-enable | pf-disable                # 선택: OS 방화벽으로 사설망 나가기를 한 번 더 막는다
#   sudo scripts/ops/screen-render.sh uninstall [--purge]
#
# 무엇을 하나(install):
#  1. 데몬 전용 사용자 _nmvrender(관리자 아님·로그인 셸 없음·숨김)를 만든다 — 브라우저는 이 사용자로만 돈다(root 로는 서버가 뜨지 않는다).
#  2. 공개 저장소의 그 커밋을 /usr/local/nmv-render/releases/<sha> 에 받아 npm ci(root 소유·읽기 전용), Playwright Chromium 을
#     /usr/local/nmv-render/browsers 에 받는다(@playwright/test 판에 고정된 빌드).
#  3. 토큰(32바이트 무작위)을 /var/nmvrender/token(0400, _nmvrender)에 만든다 — 값은 화면에 찍지 않는다. reviewer 앱의 SCREEN_RENDER_TOKEN 에 넣는다.
#  4. LaunchDaemon bot.brut.nmv-render — --host 의 IP 에서만 듣고(--allow-from 의 IP 만 받는다), 죽으면 10초 안에 다시 뜬다. 로그는 newsyslog 가 돌린다.
#  5. 상태를 불러 샌드박스·글꼴(한·일·중)을 확인한다. macOS 는 시스템 글꼴(Apple SD Gothic Neo·Hiragino·PingFang)이 있다.
set -euo pipefail

ROOT=/usr/local/nmv-render
STATE=/var/nmvrender
USER_NAME=_nmvrender
LABEL=bot.brut.nmv-render
PLIST=/Library/LaunchDaemons/$LABEL.plist
CONFIG=$ROOT/config.env
REPO=https://github.com/JRVector9/nomorevibe.git

die() { echo "screen-render: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" = 0 ] || die "sudo 로 실행한다"; }
need_macos() { [ "$(uname -s)" = Darwin ] || die "macOS(m1-studio) 전용이다"; }
valid_ip() { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }

node_bin() {
  local bin="${NODE_BIN:-$(command -v node || true)}"
  [ -x "$bin" ] || die "node 를 찾지 못했다 — NODE_BIN=/opt/homebrew/bin/node 처럼 적는다"
  local major; major="$("$bin" -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "node 22 이상이 필요하다(지금 $major)"
  echo "$bin"
}

ensure_user() {
  if dscl . -read "/Users/$USER_NAME" >/dev/null 2>&1; then return; fi
  # 데몬 계정 범위(200~400)에서 빈 번호 — macOS 의 _postgres 같은 역할 계정과 같은 방식이다(로그인 창에 나오지 않는다)
  local id
  for id in $(seq 260 399); do
    if ! dscl . -search /Users UniqueID "$id" | grep -q . && ! dscl . -search /Groups PrimaryGroupID "$id" | grep -q .; then break; fi
  done
  dscl . -create "/Groups/$USER_NAME"
  dscl . -create "/Groups/$USER_NAME" PrimaryGroupID "$id"
  dscl . -create "/Groups/$USER_NAME" Password '*'
  dscl . -create "/Users/$USER_NAME"
  dscl . -create "/Users/$USER_NAME" UniqueID "$id"
  dscl . -create "/Users/$USER_NAME" PrimaryGroupID "$id"
  dscl . -create "/Users/$USER_NAME" UserShell /usr/bin/false
  dscl . -create "/Users/$USER_NAME" NFSHomeDirectory "$STATE"
  dscl . -create "/Users/$USER_NAME" RealName "nomorevibe screen render"
  dscl . -create "/Users/$USER_NAME" Password '*'
  dscl . -create "/Users/$USER_NAME" IsHidden 1
  echo "사용자 $USER_NAME(uid $id)를 만들었다"
}

ensure_state() {
  mkdir -p "$STATE/logs" "$STATE/tmp"
  chown -R "$USER_NAME:$USER_NAME" "$STATE"
  chmod 700 "$STATE" "$STATE/tmp"
  if [ ! -s "$STATE/token" ]; then
    (umask 377 && openssl rand -hex 32 > "$STATE/token")
    echo "토큰을 만들었다 — reviewer 앱(M3·mini)의 SCREEN_RENDER_TOKEN 에 넣는다: sudo cat $STATE/token"
  fi
  chown "$USER_NAME:$USER_NAME" "$STATE/token"
  chmod 400 "$STATE/token"
  cat > /etc/newsyslog.d/nmv-render.conf <<EOF
$STATE/logs/render.log $USER_NAME:$USER_NAME 640 5 10240 * J
EOF
}

fetch_release() { # sha
  local sha=$1 dir="$ROOT/releases/$1"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "--sha 는 main 커밋 40자"
  mkdir -p "$ROOT/releases" "$ROOT/browsers"
  if [ ! -f "$dir/.installed" ]; then
    rm -rf "$dir.part"
    git init -q "$dir.part"
    git -C "$dir.part" fetch -q --depth 1 "$REPO" "$sha"
    git -C "$dir.part" checkout -q FETCH_HEAD
    [ "$(git -C "$dir.part" rev-parse HEAD)" = "$sha" ] || die "받은 커밋이 $sha 가 아니다"
    rm -rf "$dir.part/.git"
    (cd "$dir.part" && npm ci --no-audit --no-fund >/dev/null)
    # 브라우저는 @playwright/test 판에 고정된 빌드다 — 다른 판의 브라우저를 쓰지 않는다
    (cd "$dir.part" && PLAYWRIGHT_BROWSERS_PATH="$ROOT/browsers" npx playwright install chromium >/dev/null)
    touch "$dir.part/.installed"
    rm -rf "$dir" && mv "$dir.part" "$dir"
  fi
  chown -R root:wheel "$ROOT"
  chmod -R a+rX,go-w "$ROOT"
  ln -sfn "$dir" "$ROOT/current"
}

# macOS 응용 프로그램 방화벽은 프로그램(실제 파일) 단위로 들어오는 연결을 막는다 — 켜져 있으면 node 를 허용해야 M3·mini 가 닿는다
# (2026-10-22 첫 설치: 서버는 떴는데 방화벽이 node 를 막아 모든 연결이 실패했다). Homebrew 의 /opt/homebrew/bin/node 는 Cellar 판으로 가는
# 링크라 node 를 올리면 실제 경로가 바뀐다 — 그때마다 `screen-render.sh firewall` 로 다시 허용한다.
allow_firewall() { # node
  local fw=/usr/libexec/ApplicationFirewall/socketfilterfw real
  [ -x "$fw" ] || return 0
  "$fw" --getglobalstate 2>/dev/null | grep -qi enabled || { echo "macOS 방화벽 꺼짐 — 허용할 것 없음"; return 0; }
  real="$(realpath "$1" 2>/dev/null || readlink -f "$1")"
  [ -x "$real" ] || die "node 실제 경로를 찾지 못했다: $1"
  "$fw" --add "$real" >/dev/null
  "$fw" --unblockapp "$real" >/dev/null
  echo "macOS 방화벽: $real 들어오는 연결 허용"
}

write_plist() { # node sha
  # shellcheck disable=SC1090
  . "$CONFIG"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>UserName</key><string>$USER_NAME</string>
  <key>GroupName</key><string>$USER_NAME</string>
  <key>ProgramArguments</key><array><string>$1</string><string>--import</string><string>tsx</string><string>scripts/screen-render/server.ts</string></array>
  <key>WorkingDirectory</key><string>$ROOT/current</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$STATE</string>
    <key>TMPDIR</key><string>$STATE/tmp/</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_ENV</key><string>production</string>
    <key>PLAYWRIGHT_BROWSERS_PATH</key><string>$ROOT/browsers</string>
    <key>SCREEN_RENDER_HOST</key><string>$HOST</string>
    <key>SCREEN_RENDER_PORT</key><string>$PORT</string>
    <key>SCREEN_RENDER_TOKEN_FILE</key><string>$STATE/token</string>
    <key>SCREEN_RENDER_ALLOW_FROM</key><string>$ALLOW_FROM,$HOST</string>
    <key>SCREEN_RENDER_CONCURRENCY</key><string>$CONCURRENCY</string>
    <key>SCREEN_RENDER_VERSION</key><string>$2</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>Nice</key><integer>5</integer>
  <key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>4096</integer></dict>
  <key>StandardOutPath</key><string>$STATE/logs/render.log</string>
  <key>StandardErrorPath</key><string>$STATE/logs/render.log</string>
</dict></plist>
EOF
  chown root:wheel "$PLIST"
  chmod 644 "$PLIST"
  launchctl bootout "system/$LABEL" 2>/dev/null || true
  launchctl bootstrap system "$PLIST"
}

health() {
  # shellcheck disable=SC1090
  . "$CONFIG"
  local token; token="$(cat "$STATE/token")"
  for _ in $(seq 1 30); do
    if curl -fsS -m 5 -H "Authorization: Bearer $token" "http://$HOST:$PORT/v1/health" 2>/dev/null; then echo; return 0; fi
    sleep 2
  done
  echo "상태를 받지 못했다 — tail -50 $STATE/logs/render.log" >&2
  return 1
}

pf_rules() {
  # 이 사용자가 연 소켓은 사설·루프백·링크로컬·CGNAT(Tailscale)·멀티캐스트로 나가지 못한다. 루프백(브라우저 → 프록시)과 워커에서 들어온 연결의
  # 답(상태로 지난다)만 둔다. DNS 는 mDNSResponder(다른 사용자)가 풀어 걸리지 않는다
  # shellcheck disable=SC1090
  . "$CONFIG"
  cat > /etc/pf.anchors/nmv-render <<EOF
table <nmv_private> const { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3, ::1, fc00::/7, fe80::/10, ff00::/8 }
pass quick on lo0 all
pass in quick proto tcp from 100.64.0.0/10 to $HOST port $PORT keep state
block drop out quick proto { tcp, udp } from any to <nmv_private> user $USER_NAME
EOF
}

case "${1:-}" in
  install)
    need_root; need_macos; shift
    SHA="" HOST="" ALLOW_FROM="" PORT=8790 CONCURRENCY=2
    while [ $# -gt 0 ]; do
      case "$1" in
        --sha) SHA=$2; shift 2 ;;
        --host) HOST=$2; shift 2 ;;
        --allow-from) ALLOW_FROM=$2; shift 2 ;;
        --port) PORT=$2; shift 2 ;;
        --concurrency) CONCURRENCY=$2; shift 2 ;;
        *) die "모르는 인자 $1" ;;
      esac
    done
    valid_ip "$HOST" || die "--host 에 그 Mac 의 Tailscale IPv4 를 적는다(tailscale ip -4)"
    [[ "$HOST" == 100.* ]] || die "--host 는 Tailscale(100.64/10) 주소다 — 공개·LAN 주소에서 듣지 않는다"
    [ -n "$ALLOW_FROM" ] || die "--allow-from 에 reviewer 를 돌리는 M3·mini 의 Tailscale IP 를 쉼표로 적는다"
    for ip in ${ALLOW_FROM//,/ }; do valid_ip "$ip" || die "--allow-from: $ip"; done
    [[ "$PORT" =~ ^[0-9]+$ ]] || die "--port"
    NODE="$(node_bin)"
    ensure_user
    ensure_state
    mkdir -p "$ROOT"
    printf 'HOST=%s\nPORT=%s\nALLOW_FROM=%s\nCONCURRENCY=%s\nNODE=%s\n' "$HOST" "$PORT" "$ALLOW_FROM" "$CONCURRENCY" "$NODE" > "$CONFIG"
    fetch_release "$SHA"
    write_plist "$NODE" "$SHA"
    allow_firewall "$NODE"
    health
    ;;
  upgrade)
    need_root; need_macos; shift
    [ "${1:-}" = --sha ] || die "upgrade --sha <커밋>"
    [ -f "$CONFIG" ] || die "먼저 install"
    # shellcheck disable=SC1090
    . "$CONFIG"
    fetch_release "$2"
    write_plist "$NODE" "$2"
    allow_firewall "$NODE"
    health
    ;;
  firewall)
    need_root; need_macos
    [ -f "$CONFIG" ] || die "먼저 install"
    # shellcheck disable=SC1090
    . "$CONFIG"
    allow_firewall "$NODE"
    health
    ;;
  status)
    need_root
    launchctl print "system/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit" || echo "등록 안 됨"
    [ -f "$CONFIG" ] && health || true
    ;;
  pf-enable)
    need_root; need_macos
    [ -f "$CONFIG" ] || die "먼저 install"
    pf_rules
    grep -q 'anchor "nmv-render"' /etc/pf.conf || printf '\nanchor "nmv-render"\nload anchor "nmv-render" from "/etc/pf.anchors/nmv-render"\n' >> /etc/pf.conf
    pfctl -nf /etc/pf.conf
    pfctl -f /etc/pf.conf 2>/dev/null
    pfctl -E 2>/dev/null || true
    pfctl -a nmv-render -sr
    echo "macOS 업데이트가 /etc/pf.conf 를 되돌릴 수 있다 — 업데이트 뒤 pf-enable 을 다시 돌린다"
    ;;
  pf-disable)
    need_root; need_macos
    pfctl -a nmv-render -F rules 2>/dev/null || true
    sed -i '' '/anchor "nmv-render"/d;/load anchor "nmv-render"/d' /etc/pf.conf
    pfctl -f /etc/pf.conf 2>/dev/null || true
    ;;
  uninstall)
    need_root; need_macos
    launchctl bootout "system/$LABEL" 2>/dev/null || true
    rm -f "$PLIST" /etc/newsyslog.d/nmv-render.conf
    if [ "${2:-}" = --purge ]; then
      rm -rf "$ROOT" "$STATE"
      dscl . -delete "/Users/$USER_NAME" 2>/dev/null || true
      dscl . -delete "/Groups/$USER_NAME" 2>/dev/null || true
    fi
    ;;
  *) echo "usage: $0 install|upgrade|status|firewall|pf-enable|pf-disable|uninstall" >&2; exit 2 ;;
esac
