#!/usr/bin/env python3
"""deepseek 품질 표본(2026-11-18) — 운영 wire 를 M3 deepseek 엔진에 한 번에 1건씩 순서대로 보낸다.

운영 영향 규칙(사람 지시):
  - 동시 호출 없음, 호출 사이 최소 2초, 요청마다 120초 제한
  - 두 작업 합쳐 150건 이하(--budget-file 에 누적 호출 수를 적어 넘지 않는다)
  - 10건마다 운영 장부의 deepseek 경로 기다림(dispatched_at - queued_at, 최근 10분)을 재고 평균이 30초를 넘으면 멈춘다
  - 매 호출 전 시작 뒤 새로 생긴 deepseek 미확정(indeterminate)이 있으면 멈춘다(2026-11-18 추가).
    평균 기다림은 디스패치된 요청만 세므로, 미확정이 1칸을 600초 잡아 운영이 통째로 멈춘 것을 잡지 못했다(운영 약 19분 정지).
    1칸 엔진을 장부 밖에서 부르면 이런 일이 생긴다 — 이 도구로 운영 중인 엔진을 다시 부르지 않는다.
키·비밀 값 없음(엔진은 키 없이 받는다). 운영 DB 는 ops 도구의 읽기 전용 SELECT 로만 읽는다.

usage: run-serial.py <cases.jsonl> <responses.jsonl> --budget-file F [--endpoint URL] [--max N] [--wait-check CMD]
"""
import argparse, json, os, subprocess, sys, time, urllib.request, urllib.error

WAIT_SQL = """SELECT count(*) n, round(avg(extract(epoch from dispatched_at-queued_at))::numeric,2) avg_wait,
 round(max(extract(epoch from dispatched_at-queued_at))::numeric,1) max_wait,
 count(*) filter (where state='indeterminate') indet,
 round(avg(extract(epoch from settled_at-dispatched_at)) filter (where route_id<>'crawl-publish-classify')::numeric,1) avg_run_short
 FROM model_capacity_requests WHERE model ILIKE '%deepseek-v4.1-flash-1017%' AND dispatched_at IS NOT NULL
 AND queued_at > now() - interval '10 minutes'"""


INDET_SQL = """SELECT count(*) n FROM model_capacity_requests WHERE model ILIKE '%deepseek-v4.1-flash-1017%'
 AND state='indeterminate' AND queued_at > now() - interval '{minutes} minutes'"""


def ops_wait(cmd, sql=WAIT_SQL):
    """읽기 전용 SQL 을 cmd(셸 함수 ro_sql 을 부르는 bash 명령)로 실행해 기다림 요약을 돌려준다. 실패하면 None."""
    try:
        out = subprocess.run(["bash", "-c", cmd, "_", sql], capture_output=True, text=True, timeout=60).stdout
        row = json.loads(out)[0]
        return {k: (float(v) if v is not None else None) for k, v in row.items()}
    except Exception as error:  # noqa: BLE001 — 측정 실패는 기록만 하고 다음 확인에서 다시 본다
        return {"error": str(error)[:200]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cases"); ap.add_argument("responses")
    ap.add_argument("--budget-file", required=True)
    ap.add_argument("--budget", type=int, default=150)
    ap.add_argument("--endpoint", default="http://m3ultra:8010/v1/chat/completions")
    ap.add_argument("--max", type=int, default=50)
    ap.add_argument("--gap", type=float, default=2.0)
    ap.add_argument("--timeout", type=float, default=120.0)
    ap.add_argument("--wait-check", default=None, help="bash 명령: $1 로 SQL 을 받아 JSON 배열을 출력")
    ap.add_argument("--wait-limit", type=float, default=30.0)
    ap.add_argument("--log", default=None)
    args = ap.parse_args()

    cases = [json.loads(l) for l in open(args.cases) if l.strip()]
    done = set()
    if os.path.exists(args.responses):
        done = {json.loads(l)["i"] for l in open(args.responses) if l.strip()}
    used = int(open(args.budget_file).read().strip() or 0) if os.path.exists(args.budget_file) else 0
    log = open(args.log, "a") if args.log else sys.stderr

    def note(kind, **data):
        log.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "kind": kind, **data}) + "\n"); log.flush()

    sent = 0
    started = time.monotonic()
    for case in cases:
        if case["i"] in done:
            continue
        if sent >= args.max:
            break
        if used >= args.budget:
            note("budget_stop", used=used); break
        if args.wait_check:
            minutes = int((time.monotonic() - started) / 60) + 1
            indet = ops_wait(args.wait_check, INDET_SQL.format(minutes=minutes))
            if indet.get("n") is None or indet["n"] > 0:
                note("indeterminate_stop", **indet); break
        if args.wait_check and sent % 10 == 0:
            wait = ops_wait(args.wait_check); note("ops_wait", sent=sent, **wait)
            if wait.get("avg_wait") is not None and wait["avg_wait"] > args.wait_limit:
                note("wait_stop", **wait); break
        body = case["wire"].encode()
        req = urllib.request.Request(args.endpoint, data=body, headers={"content-type": "application/json"}, method="POST")
        start = time.monotonic(); result = {"i": case["i"]}
        try:
            with urllib.request.urlopen(req, timeout=args.timeout) as resp:
                raw = resp.read().decode()
            ms = round((time.monotonic() - start) * 1000)
            data = json.loads(raw)
            choice = data["choices"][0]
            result.update(ms=ms, status=200, content=choice["message"].get("content"), finish=choice.get("finish_reason"),
                          usage=data.get("usage"), model=data.get("model"))
        except urllib.error.HTTPError as error:
            result.update(ms=round((time.monotonic() - start) * 1000), status=error.code, error=f"http_{error.code}",
                          detail=error.read().decode(errors="replace")[:300])
        except Exception as error:  # noqa: BLE001 — 시간 초과·연결 실패는 그 건의 결과로 남긴다
            name = type(error).__name__
            result.update(ms=round((time.monotonic() - start) * 1000), status=None,
                          error="timeout" if "timeout" in str(error).lower() or name == "TimeoutError" else "network", detail=str(error)[:300])
        used += 1; sent += 1
        open(args.budget_file, "w").write(str(used))
        with open(args.responses, "a") as out:
            out.write(json.dumps(result, ensure_ascii=False) + "\n")
        note("call", i=case["i"], ms=result.get("ms"), status=result.get("status"), error=result.get("error"),
             tokens=(result.get("usage") or {}).get("completion_tokens"), used=used)
        time.sleep(args.gap)
    if args.wait_check:
        wait = ops_wait(args.wait_check); note("ops_wait_end", sent=sent, **wait)
    note("done", sent=sent, used=used)


if __name__ == "__main__":
    main()
