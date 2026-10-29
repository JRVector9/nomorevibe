#!/bin/sh
# m3ultra 유지보수 컨테이너(app-navigate-neural-system-yf43c7) 안에서만 실행하는 29877f65 단계 실행기. POSIX sh(alpine).
# stdin으로 이 파일을 넘긴다: docker exec -i <CID> sh -s -- <명령> [인자...] < in-container.sh
# 직접 primary URL은 컨테이너 DATABASE_URL의 계정으로 host/port/db만 10/28 0140~0142 적용 경로(100.99.209.55:5432/nomorevibe)로 바꿔
# 파이프·프로세스 환경으로만 넘긴다. URL·비밀 값은 출력·argv·파일에 남기지 않는다.
# DB 쓰기는 drain/open(정식 pipeline-control --execute)과 release --apply(정식 해제 CLI) 세 곳뿐이다.
set -eu
BASE=/tmp/nmv-release-29877f65
SRC=$BASE/src
IN=$BASE/in
RUNS=$BASE/runs
ASSEMBLE=scripts/ops/release-29877f65/assemble.ts

direct_url() {
  node -e 'const u=new URL(process.env.DATABASE_URL);u.hostname="100.99.209.55";u.port="5432";u.pathname="/nomorevibe";
for (const k of [...u.searchParams.keys()]) if (k !== "sslmode") u.searchParams.delete(k);
process.stdout.write(u.href + "\n");' </dev/null
}
die() { printf '{"error":"%s"}\n' "$1" >&2; exit 2; }
hex64() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{64}$' || die "sha256_required"; }
word() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$' || die "plain_word_required"; }
control() { # capacity mode via the reviewed pipeline-control CAS. Default dry-run; the 5th argument --execute writes.
  to=$1 from=$2 epoch=$3 revision=$4 operator=$5 reason=$6 execute=${7:-}
  word "$operator"; word "$reason"
  [ -z "$execute" ] || [ "$execute" = "--execute" ] || die "execute_flag"
  PIPELINE_CONTROL_DATABASE_URL="$(direct_url)" node --import tsx scripts/ops/pipeline-control.ts capacity mode --to="$to" --from-mode="$from" \
    --expect-epoch="$epoch" --expect-revision="$revision" --operator="$operator" --reason="$reason" --json $execute </dev/null
}

main() {
  cmd=${1:-}; [ $# -gt 0 ] && shift
  case "$cmd" in
    stage) # stage <src.tar sha256>: verify the received tar, extract once, reuse the image's identical node_modules.
      hex64 "${1:-}"
      [ "$(sha256sum "$BASE/src.tar" | cut -c1-64)" = "$1" ] || die "source_tar_sha_mismatch"
      [ ! -e "$SRC" ] || die "source_dir_exists_use_new_base"
      mkdir -m 700 "$SRC" "$IN" "$RUNS" && tar -x -f "$BASE/src.tar" -C "$SRC" </dev/null
      [ "$(sha256sum /app/package-lock.json | cut -c1-64)" = "$(sha256sum "$SRC/package-lock.json" | cut -c1-64)" ] || die "package_lock_differs_from_image"
      ln -s /app/node_modules "$SRC/node_modules"
      printf '{"staged":"%s","node":"%s","lock":"same_as_image"}\n' "$SRC" "$(node -v </dev/null)" ;;
    db-target) cd "$SRC"; direct_url | node --import tsx "$ASSEMBLE" db-target --database-url-stdin ;;
    status) cd "$SRC"; PIPELINE_CONTROL_DATABASE_URL="$(direct_url)" node --import tsx scripts/ops/pipeline-control.ts status --json </dev/null ;;
    preflight) # preflight <m3 sha> <mini sha> <m1 sha>
      cd "$SRC"; hex64 "${1:-}"; hex64 "${2:-}"; hex64 "${3:-}"
      direct_url | node --import tsx "$ASSEMBLE" preflight --database-url-stdin --bundle-m3="$IN/bundle-m3ultra.json" --bundle-m3-sha="$1" \
        --bundle-mini="$IN/bundle-9mini.json" --bundle-mini-sha="$2" --bundle-m1="$IN/bundle-m1.json" --bundle-m1-sha="$3" ;;
    drain) cd "$SRC"; control draining open "$@" ;;   # drain <epoch> <revision> <operator> <reason> [--execute]
    open) cd "$SRC"; control open draining "$@" ;;    # open <epoch> <revision> <operator> <reason> [--execute]
    plan) # plan <run name> <reference>
      cd "$SRC"; word "${1:-}"; word "${2:-}"
      direct_url | node --import tsx "$ASSEMBLE" plan --database-url-stdin --out-dir="$RUNS/$1" --reference="$2" ;;
    receipt) # receipt <run> <plan sha> <m3 sha> <mini sha> <m1 sha> <topology reviewer> <operator>
      cd "$SRC"; word "${1:-}"; hex64 "${2:-}"; hex64 "${3:-}"; hex64 "${4:-}"; hex64 "${5:-}"; word "${6:-}"; word "${7:-}"
      node --import tsx "$ASSEMBLE" receipt --dir="$RUNS/$1" --plan-sha="$2" --bundle-m3="$RUNS/$1/bundle-m3ultra.json" --bundle-m3-sha="$3" \
        --bundle-mini="$RUNS/$1/bundle-9mini.json" --bundle-mini-sha="$4" --bundle-m1="$RUNS/$1/bundle-m1.json" --bundle-m1-sha="$5" \
        --topology-reviewed-by="$6" --operator="$7" </dev/null ;;
    release) # release <run> <plan sha> <receipt sha> <operator> <reference> [--apply]  (default: full write + ROLLBACK dry-run)
      cd "$SRC"; word "${1:-}"; hex64 "${2:-}"; hex64 "${3:-}"; word "${4:-}"; word "${5:-}"
      apply=${6:-}; [ -z "$apply" ] || [ "$apply" = "--apply" ] || die "apply_flag"
      direct_url | node --import tsx scripts/ops/model-replaced-provider-boundary-release.ts --plan="$RUNS/$1/plan.json" --plan-sha="$2" \
        --receipt="$RUNS/$1/receipt.json" --receipt-sha="$3" --artifact-dir="$RUNS/$1/artifacts" --operator="$4" --reference="$5" \
        --database-url-stdin $apply ;;
    readback) cd "$SRC"; direct_url | node --import tsx "$ASSEMBLE" readback --database-url-stdin ;;
    *) die "usage_stage|db-target|status|preflight|drain|open|plan|receipt|release|readback" ;;
  esac
}
main "$@"
