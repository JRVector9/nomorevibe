#!/bin/bash
# 29877f65 해제 근거: M1 relay receipt·복구 proof·현재 relay/모델 프로세스 읽기 전용 수집.
# 대표가 device_admin(root)으로 절대 경로 argv로 실행한다. 쓰기·정지·재시작·launchctl 변경 0.
# 읽는 것: receipt/복구 proof 파일 bytes, active.json·복구 잠금 존재, `launchctl print`, ps, lsof, 127.0.0.1:8000 /v1/models(GET).
# upstream 토큰은 프로세스 메모리 안에서 헤더로만 쓰고 출력·argv·파일에 남기지 않는다.
# 결과 묶음 JSON은 stdout, 그 SHA-256은 stderr 마지막 줄.
#   {"executable":"/bin/bash","args":["<검토한 절대경로>/collect-m1.sh"]}
set -euo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
RELAY_REQUEST_ID=6571d6c8-002f-4f5f-b399-47e40876ee43
RECOVERY_DIR=/Users/jinwooro/.local/share/nomorevibe-m1-translation-20261028/receipts-20261029
for arg in "$@"; do
  case "$arg" in
    --recovery-dir=/*) RECOVERY_DIR="${arg#--recovery-dir=}" ;;
    *) echo '{"error":"collect_m1_usage","expected":"[--recovery-dir=/absolute/path]"}' >&2; exit 2 ;;
  esac
done
[ "$(/usr/bin/id -u)" = 0 ] || { echo '{"error":"collect_m1_root_required"}' >&2; exit 2; }
/usr/bin/python3 -I - "$RELAY_REQUEST_ID" "$RECOVERY_DIR" <<'PY'
import base64, datetime, hashlib, json, os, re, stat, subprocess, sys, time, urllib.request
relay_id, recovery_dir = sys.argv[1], sys.argv[2]
STATE, LABEL, NATIVE_PORT, LIMIT = "/var/nmvllm", "bot.brut.nmv-llm-relay", 8000, 1024 * 1024
RECEIPTS = STATE + "/receipts"
def now(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
def regular(path):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_size > LIMIT: raise ValueError("not_regular_or_too_large:" + path)
    with open(path, "rb") as handle: data = handle.read(LIMIT + 1)
    return {"path": path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "base64": base64.b64encode(data).decode(),
            "uid": info.st_uid, "mode": oct(info.st_mode & 0o7777), "mtime": datetime.datetime.fromtimestamp(info.st_mtime, datetime.timezone.utc).isoformat()}, data
def run(args):
    r = subprocess.run(args, capture_output=True, text=True, timeout=15, env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C", "TZ": "UTC"})
    return r.returncode, r.stdout
def process(pid):
    """ps without command arguments (no secrets); lstart is second-resolution, interpreted as UTC."""
    code, out = run(["/bin/ps", "-o", "pid=,pgid=,ppid=,uid=,lstart=", "-p", str(pid)])
    if code != 0 or not out.strip(): return None
    f = out.split()
    started = datetime.datetime(*time.strptime(" ".join(f[4:9]), "%a %b %d %H:%M:%S %Y")[:6], tzinfo=datetime.timezone.utc)
    _, comm = run(["/bin/ps", "-o", "comm=", "-p", str(pid)])
    return {"pid": int(f[0]), "pgid": int(f[1]), "ppid": int(f[2]), "uid": int(f[3]), "lstart": " ".join(f[4:9]),
            "startedAt": started.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "comm": os.path.basename(comm.strip())}
bundle = {"kind": "nmv-release-29877f65-m1-bundle", "version": 1, "host": "m1studio", "euid": os.geteuid(), "relayRequestId": relay_id,
          "recoveryDir": recovery_dir, "warnings": []}
receipt, receipt_bytes = regular(os.path.join(RECEIPTS, relay_id + ".json"))
bundle["receipt"] = receipt
active = os.path.join(RECEIPTS, "active.json")
bundle["relayState"] = {"activeJsonPresent": os.path.lexists(active), "activeJson": regular(active)[0] if os.path.lexists(active) else None,
    "recoveryLockPresent": os.path.lexists(os.path.join(RECEIPTS, ".boundary-recovery.lock")),
    "receiptNames": sorted(n for n in os.listdir(RECEIPTS) if re.fullmatch(r"[0-9a-f-]{36}\.json|.*\.boundary-release\.json", n))[-200:]}
candidates, listing = [], []
for name in sorted(os.listdir(recovery_dir)):
    path = os.path.join(recovery_dir, name)
    if not name.endswith(".json") or not stat.S_ISREG(os.lstat(path).st_mode): continue
    try: entry, data = regular(path)
    except ValueError: continue
    listing.append({"name": name, "size": entry["size"], "sha256": entry["sha256"]})
    try: doc = json.loads(data)
    except ValueError: continue
    if isinstance(doc, dict) and doc.get("kind") == "m1-original-request-relay-recovery" and doc.get("relayRequestId") == relay_id:
        candidates.append(entry)
bundle["recoveryCandidates"], bundle["recoveryDirListing"] = candidates, listing
code, out = run(["/bin/launchctl", "print", "system/" + LABEL])
launchd = {"exitCode": code}
for line in out.splitlines():
    m = re.match(r"\s*(state|pid|runs|last exit code)\s*=\s*(.+?)\s*$", line)
    if m and m.group(1) not in launchd: launchd[m.group(1)] = m.group(2)
bundle["launchd"] = launchd
relay_pid = int(launchd["pid"]) if str(launchd.get("pid", "")).isdigit() else None
bundle["relayProcess"] = process(relay_pid) if relay_pid else None
code, out = run(["/usr/sbin/lsof", "-nP", "-a", "-iTCP@127.0.0.1:%d" % NATIVE_PORT, "-sTCP:LISTEN", "-Fp"])
pids = sorted({int(line[1:]) for line in out.splitlines() if line.startswith("p") and line[1:].isdigit()})
bundle["nativeListener"] = {"port": NATIVE_PORT, "pids": pids, "lsofExit": code}
bundle["nativeProcess"] = process(pids[0]) if len(pids) == 1 else None
try:
    with open(STATE + "/upstream-token", "rb") as handle: token = handle.read(4096).decode().strip()
    request = urllib.request.Request("http://127.0.0.1:%d/v1/models" % NATIVE_PORT, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(request, timeout=5) as response:
        body = json.loads(response.read(100 * 1024))
        bundle["nativeModels"] = {"status": response.status, "ids": sorted(str(m.get("id")) for m in body.get("data", []) if isinstance(m, dict))}
    del token
except Exception as error:
    bundle["nativeModels"] = {"error": type(error).__name__}
original = None
if len(candidates) == 1:
    original = (json.loads(base64.b64decode(candidates[0]["base64"])).get("originalNativeIdentity") or {}).get("pid")
code, out = run(["/bin/ps", "-axo", "pid=,pgid="])
rows = [tuple(map(int, line.split())) for line in out.splitlines() if len(line.split()) == 2]
bundle["originalModel"] = {"pid": original, "pidPresent": any(p == original for p, _ in rows) if original else None,
                           "groupPresent": any(g == original for _, g in rows) if original else None, "psExit": code}
recent = []
for name in bundle["relayState"]["receiptNames"][-200:]:
    if not re.fullmatch(r"[0-9a-f-]{36}\.json", name): continue
    try: doc = json.loads(regular(os.path.join(RECEIPTS, name))[1])
    except Exception: continue
    recent.append({k: doc.get(k) for k in ("requestId", "relayGeneration", "startedAt", "state")})
bundle["recentReceipts"] = sorted(recent, key=lambda r: str(r.get("startedAt")))[-20:]
code, out = run(["/usr/sbin/sysctl", "-n", "kern.boottime"])
bundle["bootTime"] = out.strip()
if bundle["relayState"]["activeJsonPresent"]: bundle["warnings"].append("relay_active_json_present")
if len(candidates) != 1: bundle["warnings"].append("recovery_candidates=%d" % len(candidates))
bundle["observedAt"] = now()
data = (json.dumps(bundle, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
sys.stdout.buffer.write(data); sys.stdout.flush()
sys.stderr.write(json.dumps({"bundle": "m1", "warnings": bundle["warnings"], "sha256": hashlib.sha256(data).hexdigest()}) + "\n")
PY
