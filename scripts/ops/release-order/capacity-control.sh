#!/bin/sh
# m3ultra 유지보수 컨테이너 안에서 모델 접수 상태 확인과 OPEN만 하는 실행기. POSIX sh(alpine).
# docker exec -i <CID> sh -s -- stage <tar sha256> | status | routes | open <epoch> <revision> <operator> <reason> [--execute] < capacity-control.sh
# 운영 이미지는 .dockerignore가 scripts/ops를 빼므로 /app에는 scripts/ops가 없다. 그래서 /app의 스크립트를 실행하지 않는다.
# 검토한 SHA의 tar(git archive)를 $BASE/src.tar로 넘긴 뒤 stage로 sha256과 package-lock(이미지 /app의 것과 같아야 함)을 확인하고
# $BASE/src에 한 번만 풀며, node_modules는 이미지 /app/node_modules를 심링크로 쓴다(release-29877f65/in-container.sh와 같은 방식).
# 확인이 하나라도 어긋나면 아무것도 쓰지 않고 멈춘다. status·routes·open은 스테이징한 소스에서만 실행한다.
# routes는 사람이 읽는 status(이 컨테이너 env 기준 route 판정 표)다. OPEN dry-run 전에 serving·unused 밖 route가 있는지 본다.
# 계정은 컨테이너 DATABASE_URL, host/port/db만 직접 primary로 바꾼다. URL·비밀 값은 출력·argv·파일에 남기지 않는다.
# 쓰기는 정식 pipeline-control --execute 한 곳뿐이다(stage는 컨테이너 /tmp에만 쓴다).
set -eu
APP=${NMV_APP_DIR:-/app}
BASE=${NMV_STAGE_BASE:-/tmp/nmv-release-order}
TAR=$BASE/src.tar
SRC=$BASE/src
STAMP=.nmv-staged-tar-sha256
direct_url() {
  node -e 'const u=new URL(process.env.DATABASE_URL);u.hostname="100.99.209.55";u.port="5432";u.pathname="/nomorevibe";
for (const k of [...u.searchParams.keys()]) if (k !== "sslmode") u.searchParams.delete(k);
process.stdout.write(u.href + "\n");' </dev/null
}
die() { printf '{"error":"%s"}\n' "$1" >&2; exit 2; }
hex64() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{64}$' || die "sha256_required"; }
int() { printf '%s' "$1" | grep -Eq '^[1-9][0-9]{0,15}$' || die "positive_integer_required"; }
word() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$' || die "plain_word_required"; }
sha() { sha256sum "$1" | cut -c1-64; }
image_lock() { [ -f "$APP/package-lock.json" ] && [ -d "$APP/node_modules" ] || die "image_app_missing"; sha "$APP/package-lock.json"; }
staged() { # 스테이징한 소스가 그대로이고 이미지의 node_modules와 맞는지 확인한 뒤 그 폴더로 들어간다.
  [ -f "$SRC/$STAMP" ] || die "source_not_staged"
  [ -L "$SRC/node_modules" ] && [ "$(readlink "$SRC/node_modules")" = "$APP/node_modules" ] || die "staged_node_modules_not_image"
  lock=$(image_lock)
  [ "$(sha "$SRC/package-lock.json")" = "$lock" ] || die "package_lock_differs_from_image"
  [ -f "$SRC/scripts/ops/pipeline-control.ts" ] || die "staged_pipeline_control_missing"
  cd "$SRC"
}
control() { PIPELINE_CONTROL_DATABASE_URL="$(direct_url)" node --import tsx scripts/ops/pipeline-control.ts "$@" </dev/null; }
cmd=${1:-}; [ $# -gt 0 ] && shift
case "$cmd" in
  stage) # stage <src.tar sha256>: 모든 확인을 쓰기 전에 한다. 같은 tar로 이미 스테이징했으면 그대로 둔다.
    [ $# -eq 1 ] || die "stage_arguments"; hex64 "$1"
    [ -f "$TAR" ] || die "source_tar_missing"
    [ "$(sha "$TAR")" = "$1" ] || die "source_tar_sha_mismatch"
    lock=$(image_lock)
    [ "$(tar -x -O -f "$TAR" package-lock.json </dev/null | sha256sum | cut -c1-64)" = "$lock" ] || die "package_lock_differs_from_image"
    if [ -e "$SRC" ]; then
      [ -f "$SRC/$STAMP" ] && [ "$(cat "$SRC/$STAMP")" = "$1" ] || die "source_dir_exists_with_other_tar"
      printf '{"staged":"%s","tarSha256":"%s","lock":"same_as_image","existing":true}\n' "$SRC" "$1"; exit 0
    fi
    part=$BASE/.src.partial.$$
    mkdir -m 700 "$part"
    if ! tar -x -f "$TAR" -C "$part" </dev/null || [ ! -f "$part/scripts/ops/pipeline-control.ts" ] || [ "$(sha "$part/package-lock.json")" != "$lock" ]; then
      rm -rf "$part"; die "source_tar_unusable"
    fi
    ln -s "$APP/node_modules" "$part/node_modules"
    printf '%s\n' "$1" > "$part/$STAMP"
    mv "$part" "$SRC"
    printf '{"staged":"%s","tarSha256":"%s","node":"%s","lock":"same_as_image"}\n' "$SRC" "$1" "$(node -v </dev/null)" ;;
  status) [ $# -eq 0 ] || die "status_takes_no_arguments"
    staged; control status --json ;;
  routes) [ $# -eq 0 ] || die "routes_takes_no_arguments"
    staged; control status ;;
  open) # open <epoch> <revision> <operator> <reason> [--execute]. 기본 dry-run. deferred route 허용 플래그는 받지 않는다.
    [ $# -eq 4 ] || [ $# -eq 5 ] || die "open_arguments"
    int "$1"; int "$2"; word "$3"; word "$4"
    [ $# -eq 4 ] || [ "$5" = "--execute" ] || die "execute_flag"
    staged; control capacity mode --to=open --from-mode=draining \
      --expect-epoch="$1" --expect-revision="$2" --operator="$3" --reason="$4" --json ${5:-} ;;
  *) die "usage_stage|status|routes|open" ;;
esac
