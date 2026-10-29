#!/bin/sh
# 배포 뒤 새 m3ultra 유지보수 컨테이너 안에서 모델 접수 상태 확인과 OPEN만 하는 실행기. POSIX sh(alpine).
# docker exec -i <CID> sh -s -- status | routes | open <epoch> <revision> <operator> <reason> [--execute] < capacity-control.sh
# routes는 사람이 읽는 status(이 컨테이너 env 기준 route 판정 표)다. OPEN dry-run 전에 serving·unused 밖 route가 있는지 본다.
# 이미지의 /app(배포된 SHA의 scripts·node_modules)을 그대로 쓰고, 계정은 컨테이너 DATABASE_URL, host/port/db만 직접 primary로 바꾼다
# (release-29877f65/in-container.sh와 같은 경로). URL·비밀 값은 출력·argv·파일에 남기지 않는다. 쓰기는 정식 pipeline-control --execute 한 곳뿐이다.
set -eu
APP=${NMV_APP_DIR:-/app}
direct_url() {
  node -e 'const u=new URL(process.env.DATABASE_URL);u.hostname="100.99.209.55";u.port="5432";u.pathname="/nomorevibe";
for (const k of [...u.searchParams.keys()]) if (k !== "sslmode") u.searchParams.delete(k);
process.stdout.write(u.href + "\n");' </dev/null
}
die() { printf '{"error":"%s"}\n' "$1" >&2; exit 2; }
int() { printf '%s' "$1" | grep -Eq '^[1-9][0-9]{0,15}$' || die "positive_integer_required"; }
word() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$' || die "plain_word_required"; }
cmd=${1:-}; [ $# -gt 0 ] && shift
cd "$APP"
case "$cmd" in
  status) [ $# -eq 0 ] || die "status_takes_no_arguments"
    PIPELINE_CONTROL_DATABASE_URL="$(direct_url)" node --import tsx scripts/ops/pipeline-control.ts status --json </dev/null ;;
  routes) [ $# -eq 0 ] || die "routes_takes_no_arguments"
    PIPELINE_CONTROL_DATABASE_URL="$(direct_url)" node --import tsx scripts/ops/pipeline-control.ts status </dev/null ;;
  open) # open <epoch> <revision> <operator> <reason> [--execute]. 기본 dry-run. deferred route 허용 플래그는 받지 않는다.
    [ $# -eq 4 ] || [ $# -eq 5 ] || die "open_arguments"
    int "$1"; int "$2"; word "$3"; word "$4"
    [ $# -eq 4 ] || [ "$5" = "--execute" ] || die "execute_flag"
    PIPELINE_CONTROL_DATABASE_URL="$(direct_url)" node --import tsx scripts/ops/pipeline-control.ts capacity mode --to=open --from-mode=draining \
      --expect-epoch="$1" --expect-revision="$2" --operator="$3" --reason="$4" --json ${5:-} </dev/null ;;
  *) die "usage_status|routes|open" ;;
esac
